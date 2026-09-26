import OpenAI from "openai";
import { cfg } from "./config.js";
import { formatSchemaForPrompt, createSchemaDefault, healStructuredContent, cleanJson, withTimeout } from "./utils.js";

export const localClient = new OpenAI({
  baseURL: cfg.llm.baseURL,
  apiKey: cfg.llm.apiKey,
});

export function formatMessages(messages: any[], systemPrompt?: string): any[] {
  const out: any[] = [];
  if (systemPrompt) out.push({ role: "system", content: systemPrompt });
  for (const msg of messages || []) {
    const role = msg.role || "user";
    let c: any;
    if (typeof msg.content === "string") c = msg.content;
    else if (Array.isArray(msg.content)) {
      const parts: any[] = [];
      for (const b of msg.content) {
        if (!b) continue;
        if (typeof b === "string") parts.push({ type: "text", text: b });
        else if (b.type === "text") parts.push({ type: "text", text: b.text ?? "" });
        else if (b.type === "image")
          parts.push({
            type: "image_url",
            image_url: { url: `data:${b.mimeType || "image/png"};base64,${b.data}` },
          });
        else if (b.type === "tool_result")
          parts.push({
            type: "text",
            text: typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? ""),
          });
        else parts.push({ type: "text", text: JSON.stringify(b) });
      }
      c = parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
    } else if (typeof msg.content === "object" && msg.content !== null) {
      if (msg.content.type === "text") c = msg.content.text ?? "";
      else if (msg.content.type === "image")
        c = [{ type: "image_url", image_url: { url: `data:${msg.content.mimeType || "image/png"};base64,${msg.content.data}` } }];
      else c = JSON.stringify(msg.content);
    } else c = String(msg.content ?? "");
    out.push({ role, content: c });
  }
  return out;
}

export function createStagehandModelHandler(onStepLog?: (log: string) => void) {
  return {
    generate: async (params: any) => {
      try {
        const isJson = params.responseFormat?.type === "json_schema";
        const schema = isJson ? params.responseFormat?.schema : null;
        const label = params.responseFormat?.name || "LLM";
        let sys = params.systemPrompt || "";

        if (isJson && schema) {
          const guide = formatSchemaForPrompt(schema);
          let specificRules = "";
          if (schema.properties?.action || label.toLowerCase().includes("act")) {
            specificRules = `\nCRITICAL ACTION FORMAT RULES:
1. "action" MUST be either a structured object: {"elementId": "<id>", "description": "<text>", "method": "<method>", "arguments": ["<arg>"]} OR null if no matching element exists on the page. NEVER return "action" as a string or plain text.
2. "elementId" must be copied directly from the accessibility tree (e.g. "0-142", without square brackets).
3. "method" must be one of: "click", "fill", "type", "press", "scrollTo", "nextChunk", "prevChunk", "selectOptionFromDropdown", "hover", "doubleClick", "dragAndDrop".
4. "arguments" must be an array of strings (e.g. ["query\\n"] for type/fill or ["Enter"] for press).
5. "twoStep" must be a boolean (true or false).`;
          } else if (schema.properties?.elements || label.toLowerCase().includes("observe")) {
            specificRules = `\nCRITICAL OBSERVATION FORMAT RULES:
1. "elements" MUST be an array of objects: [{"elementId": "<id>", "description": "<text>", "method": "<method>", "arguments": ["<arg>"]}].`;
          } else if (schema.properties?.extraction || label.toLowerCase().includes("extract")) {
            specificRules = `\nCRITICAL EXTRACTION FORMAT RULES:
1. You MUST return a JSON object with the "extraction" property containing the requested data as a string (e.g. {"extraction": "..."}).
2. If extracting structured data or lists, serialize the information cleanly as a text/markdown string inside "extraction".
3. Do NOT include extraneous keys such as "action" or "twoStep".`;
          }

          sys += `\n\nYou MUST respond with a valid JSON object matching this structure:\n${guide}\n${specificRules}\nDo NOT include "$schema", "type", "properties", "required", or "additionalProperties" definition keys in your response. Fill in real values.`;
        }

        const msgs = formatMessages(params.messages, sys.trim());
        process.stdout.write(`   [${label}...] \r`);
        if (onStepLog) onStepLog(`[${label}...]`);

        const c: any = await withTimeout(
          localClient.chat.completions.create({
            model: cfg.llm.modelId,
            messages: msgs,
            temperature: params.temperature ?? cfg.llm.temperature,
            ...(isJson ? { response_format: { type: "json_object" as const } } : {}),
            ...(params.stopSequences?.length ? { stop: params.stopSequences } : {}),
          }),
          cfg.llm.stepTimeoutMs,
          label
        );

        process.stdout.write("                                                   \r");
        const text = c.choices?.[0]?.message?.content ?? "";
        const usage = {
          inputTokens: c.usage?.prompt_tokens ?? 0,
          outputTokens: c.usage?.completion_tokens ?? 0,
          totalTokens: c.usage?.total_tokens ?? 0,
        };

        if (isJson) {
          let sc: any = {};
          try {
            sc = JSON.parse(cleanJson(text));
            // Detect schema echo
            if (
              sc.$schema ||
              sc.additionalProperties !== undefined ||
              (sc.type && sc.properties && typeof sc.properties === "object")
            ) {
              console.warn("[LLM] Schema echo detected — extracting defaults.");
              sc = createSchemaDefault(schema);
            } else {
              sc = healStructuredContent(sc, schema, label);
            }
          } catch {
            console.warn("[LLM] JSON parse fallback.");
            sc = createSchemaDefault(schema);
          }
          return {
            role: "assistant" as const,
            content: [{ type: "text" as const, text }],
            outputFormat: "json_schema" as const,
            structuredContent: sc,
            usage,
          };
        }
        return { role: "assistant" as const, content: [{ type: "text" as const, text }], outputFormat: "text" as const, usage };
      } catch (err: any) {
        if (err?.message?.includes("timed out")) {
          console.warn(`\n⚠️ LLM call timed out.`);
          if (params.responseFormat?.type === "json_schema") {
            const sc = createSchemaDefault(params.responseFormat?.schema);
            return {
              role: "assistant" as const,
              content: [{ type: "text" as const, text: "{}" }],
              outputFormat: "json_schema" as const,
              structuredContent: sc,
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            };
          }
          return {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "" }],
            outputFormat: "text" as const,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          };
        }
        console.error("\n❌ LLM:", err);
        throw err;
      }
    },
  };
}
