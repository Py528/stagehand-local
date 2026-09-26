import { cfg } from "./config.js";

export function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function isNetworkOrCdpError(err: any): boolean {
  const msg = (err?.message || String(err)).toLowerCase();
  return (
    msg.includes("cdp") ||
    msg.includes("connection closed") ||
    msg.includes("target closed") ||
    msg.includes("protocol error") ||
    msg.includes("econnrefused") ||
    msg.includes("net::err") ||
    msg.includes("err_name_not_resolved") ||
    msg.includes("err_internet_disconnected") ||
    msg.includes("err_connection_refused") ||
    msg.includes("websocket") ||
    msg.includes("ws://") ||
    msg.includes("executable doesn't exist") ||
    msg.includes("rpc client is closed")
  );
}

export function cleanJson(text: string): string {
  if (!text) return "{}";
  // Strip <think>...</think> reasoning blocks from thinking models
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence && fence[1]) return fence[1].trim();
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a !== -1 && b > a) return text.substring(a, b + 1).trim();
  return text.trim();
}

export function csvEsc(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n"))
    return `"${val.replace(/"/g, '""')}"`;
  return val;
}

export function formatSchemaForPrompt(schema: any, indent = "  "): string {
  if (!schema || typeof schema !== "object") return "<any>";

  // Handle anyOf / oneOf
  const variants = schema.anyOf || schema.oneOf;
  if (Array.isArray(variants) && variants.length > 0) {
    const isNullable = variants.some((v: any) => v?.type === "null" || v === null);
    const nonNullVariants = variants.filter((v: any) => v && v.type !== "null");
    if (nonNullVariants.length === 1) {
      const formatted = formatSchemaForPrompt(nonNullVariants[0], indent);
      return isNullable ? `${formatted} | null` : formatted;
    } else if (nonNullVariants.length > 1) {
      const formatted = nonNullVariants.map((v: any) => formatSchemaForPrompt(v, indent)).join(" | ");
      return isNullable ? `(${formatted}) | null` : formatted;
    } else {
      return "null";
    }
  }

  // Handle enum
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((e: any) => JSON.stringify(e)).join(" | ");
  }

  // Handle object
  if (schema.type === "object" || schema.properties) {
    const props = schema.properties || {};
    const req = new Set(Array.isArray(schema.required) ? schema.required : []);
    const entries = Object.entries(props);
    if (entries.length === 0) return "{}";

    const lines = entries.map(([key, def]: [string, any]) => {
      const isReq = req.has(key) ? " (required)" : " (optional)";
      const desc = def.description ? ` — ${def.description}` : "";
      const val = formatSchemaForPrompt(def, indent + "  ");
      return `${indent}  "${key}": ${val}${desc ? ` // ${desc}${isReq}` : ""}`;
    });
    return `{\n${lines.join(",\n")}\n${indent}}`;
  }

  // Handle array
  if (schema.type === "array" || schema.items) {
    const itemFmt = schema.items ? formatSchemaForPrompt(schema.items, indent) : "<any>";
    return `[ ${itemFmt} ]`;
  }

  // Handle primitives
  if (schema.type === "string") {
    if (schema.pattern) return `<string matching regex ${schema.pattern}>`;
    return `<string>`;
  }
  if (schema.type === "number" || schema.type === "integer") {
    return `<number>`;
  }
  if (schema.type === "boolean") {
    return `<boolean>`;
  }
  if (schema.type === "null") {
    return `null`;
  }

  return `<${schema.type || "string"}>`;
}

export function createSchemaDefault(schema: any): any {
  if (!schema || typeof schema !== "object") return {};
  if (schema.properties) {
    const obj: any = {};
    for (const [key, def] of Object.entries(schema.properties) as [string, any][]) {
      if (def?.anyOf || def?.oneOf) {
        const hasNull = (def.anyOf || def.oneOf).some((v: any) => v?.type === "null");
        obj[key] = hasNull ? null : {};
      } else if (def?.type === "boolean") {
        obj[key] = def.default ?? false;
      } else if (def?.type === "number" || def?.type === "integer") {
        obj[key] = def.default ?? 0;
      } else if (def?.type === "array") {
        obj[key] = def.default ?? [];
      } else if (def?.type === "object") {
        obj[key] = createSchemaDefault(def);
      } else {
        obj[key] = def?.default ?? "";
      }
    }
    return obj;
  }
  if (schema.type === "array") return [];
  return {};
}

export function healStructuredContent(sc: any, schema: any, label: string): any {
  if (!sc || typeof sc !== "object") return createSchemaDefault(schema);

  // Unwrap common LLM wrapping keys
  const wrapperKeys = ["data", "result", "output", "response", label, label.toLowerCase()];
  for (const wk of wrapperKeys) {
    if (sc[wk] && typeof sc[wk] === "object" && !Array.isArray(sc[wk])) {
      if (sc[wk].action !== undefined || sc[wk].elements !== undefined || sc[wk].extraction !== undefined) {
        sc = sc[wk];
        break;
      }
    }
  }

  const validMethods = new Set([
    "click", "fill", "type", "press", "scrollto", "nextchunk", "prevchunk",
    "selectoptionfromdropdown", "hover", "doubleclick", "draganddrop"
  ]);

  // If schema defines specific properties, strictly construct output matching ONLY those properties
  if (schema?.properties && typeof schema.properties === "object") {
    const isActSchema = "action" in schema.properties;
    const isObserveSchema = "elements" in schema.properties;
    const isExtractSchema = "extraction" in schema.properties;

    const clean: any = {};

    // 1. Act schema handling
    if (isActSchema) {
      let act = sc.action;
      if (act === null || act === undefined || act === "null" || act === "none" || act === "") {
        clean.action = null;
      } else if (typeof act === "string") {
        const match = act.match(/(\d+-\d+)/);
        if (match) {
          const lower = act.toLowerCase();
          let method = "click";
          if (lower.includes("type")) method = "type";
          else if (lower.includes("fill")) method = "fill";
          else if (lower.includes("press") || lower.includes("enter")) method = "press";
          else if (lower.includes("scroll")) method = "scrollTo";

          clean.action = {
            elementId: match[1],
            description: act,
            method,
            arguments: [],
          };
        } else {
          clean.action = null;
        }
      } else if (typeof act === "object") {
        let rawId = String(act.elementId ?? act.id ?? act.backendNodeId ?? "").replace(/[\[\]]/g, "").trim();
        const idMatch = rawId.match(/(\d+-\d+)/);
        const elementId = idMatch ? idMatch[1] : rawId;
        const description = typeof act.description === "string" ? act.description : String(act.description ?? "");
        let method = String(act.method ?? "click").toLowerCase();
        if (!validMethods.has(method)) {
          if (method.includes("type")) method = "type";
          else if (method.includes("fill")) method = "fill";
          else if (method.includes("press")) method = "press";
          else method = "click";
        }
        let args: string[] = [];
        if (Array.isArray(act.arguments)) {
          args = act.arguments.map((a: any) => String(a ?? ""));
        } else if (act.arguments !== undefined && act.arguments !== null) {
          args = [String(act.arguments)];
        }

        if (!elementId) {
          clean.action = null;
        } else {
          clean.action = {
            elementId,
            description,
            method,
            arguments: args,
          };
        }
      } else {
        clean.action = null;
      }

      if ("twoStep" in schema.properties) {
        clean.twoStep = Boolean(sc.twoStep ?? false);
      }
      return clean;
    }

    // 2. Observe schema handling
    if (isObserveSchema) {
      if (!Array.isArray(sc.elements)) {
        clean.elements = [];
      } else {
        clean.elements = sc.elements
          .map((el: any) => {
            if (!el || typeof el !== "object") return null;
            let rawId = String(el.elementId ?? el.id ?? "").replace(/[\[\]]/g, "").trim();
            const idMatch = rawId.match(/(\d+-\d+)/);
            const elementId = idMatch ? idMatch[1] : rawId;
            if (!elementId) return null;
            const description = typeof el.description === "string" ? el.description : String(el.description ?? "");
            let method = String(el.method ?? "click").toLowerCase();
            if (!validMethods.has(method)) method = "click";
            let args: string[] = [];
            if (Array.isArray(el.arguments)) {
              args = el.arguments.map((a: any) => String(a ?? ""));
            } else if (el.arguments !== undefined && el.arguments !== null) {
              args = [String(el.arguments)];
            }
            return { elementId, description, method, arguments: args };
          })
          .filter(Boolean);
      }
      return clean;
    }

    // 3. Extract schema handling
    if (isExtractSchema) {
      if (sc.extraction !== undefined) {
        if (typeof sc.extraction === "object" && sc.extraction !== null) {
          clean.extraction = JSON.stringify(sc.extraction, null, 2);
        } else {
          clean.extraction = String(sc.extraction ?? "");
        }
      } else {
        clean.extraction = typeof sc === "string" ? sc : JSON.stringify(sc, null, 2);
      }
      return clean;
    }

    // 4. General / Metadata schema
    for (const [key, propDef] of Object.entries(schema.properties) as [string, any][]) {
      const val = sc[key];
      if (val === undefined) {
        clean[key] = createSchemaDefault(propDef);
      } else if (propDef?.type === "string" && typeof val !== "string") {
        clean[key] = typeof val === "object" ? JSON.stringify(val, null, 2) : String(val ?? "");
      } else if (propDef?.type === "boolean") {
        clean[key] = Boolean(val);
      } else if (propDef?.type === "number" || propDef?.type === "integer") {
        clean[key] = Number(val) || 0;
      } else if (propDef?.type === "array" && !Array.isArray(val)) {
        clean[key] = [val];
      } else {
        clean[key] = val;
      }
    }
    return clean;
  }

  return sc;
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0) return promise;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function retry<T>(fn: () => Promise<T>, label: string, retries = cfg.agent.maxRetries): Promise<T> {
  let lastErr: any;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      if (i < retries) {
        console.warn(`   ⚠️ ${label} transient error (${i + 1}/${retries + 1}), retrying in 1500ms...`);
        await sleep(1500);
      }
    }
  }
  throw lastErr;
}

export function isNearDuplicate(a: string, b: string): boolean {
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  if (shorter.length < 50) return false;
  return longer.includes(shorter.slice(0, Math.floor(shorter.length * 0.6)));
}
