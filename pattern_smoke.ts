import { extractFingerprint, skeletonSimilarity, computeSkeletonSubstitutions } from "./src/pattern.js";

const plan1 = { service: "youtube" as const, intent: "media_play" as const, primaryQuery: "millionaire honey singh", targetName: "millionaire", creatorOrOrg: "honey singh" };
const plan2 = { service: "youtube" as const, intent: "media_play" as const, primaryQuery: "besharam rang deepika", targetName: "besharam rang", creatorOrOrg: "deepika" };
const plan3 = { service: "youtube" as const, intent: "media_play" as const, primaryQuery: "shape of you ed sheeran", targetName: "shape of you", creatorOrOrg: "ed sheeran" };

const fp1 = extractFingerprint("play millionaire by honey singh on youtube", plan1);
const fp2 = extractFingerprint("play besharam rang by deepika on youtube", plan2);
const fp3 = extractFingerprint("play shape of you by ed sheeran", plan3);

console.log("fp1 skeleton:", fp1.skeleton);
console.log("fp2 skeleton:", fp2.skeleton);
console.log("fp3 skeleton:", fp3.skeleton);
console.log();

const sim12 = skeletonSimilarity(fp1.skeleton, fp2.skeleton);
const sim13 = skeletonSimilarity(fp1.skeleton, fp3.skeleton);
const subs = computeSkeletonSubstitutions(fp1, fp2);

console.log("sim fp1 vs fp2 (identical structure):", sim12.toFixed(3), "← expect ~1.0");
console.log("sim fp1 vs fp3 (same verb+slots, no platform):", sim13.toFixed(3), "← expect >=0.70");
console.log("substitutions fp1→fp2:", subs, "← expect millionaire→besharam rang, honey singh→deepika");

if (sim12 < 0.95) throw new Error(`Expected sim12 >= 0.95, got ${sim12}`);
if (sim13 < 0.70) throw new Error(`Expected sim13 >= 0.70, got ${sim13}`);
if (subs["millionaire"] !== "besharam rang") throw new Error(`Bad entity sub: ${JSON.stringify(subs)}`);
if (subs["honey singh"] !== "deepika") throw new Error(`Bad creator sub: ${JSON.stringify(subs)}`);
console.log("\n✅ All assertions passed");
