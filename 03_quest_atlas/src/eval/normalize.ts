import type { CanonicalFact, JsonValue, KnowledgeClaim } from "./types.ts";

function normalizeString(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function normalizeJson(value: JsonValue): JsonValue {
  if (typeof value === "string") return normalizeString(value);
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value !== null && typeof value === "object") {
    const record = value as { readonly [key: string]: JsonValue };
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [normalizeString(key), normalizeJson(record[key] as JsonValue)]),
    );
  }
  return value;
}

export function stableJson(value: JsonValue): string {
  return JSON.stringify(normalizeJson(value));
}

function normalizedConditions(conditions: readonly JsonValue[]): string {
  return JSON.stringify(conditions.map(stableJson).sort());
}

export function factBaseKey(fact: Pick<CanonicalFact | KnowledgeClaim, "subject" | "predicate" | "object">): string {
  return [normalizeString(fact.subject), normalizeString(fact.predicate), stableJson(fact.object)].join("\u241f");
}

export function factKey(fact: Pick<CanonicalFact | KnowledgeClaim, "subject" | "predicate" | "object" | "conditions">): string {
  return factBaseKey(fact) + "\u241f" + normalizedConditions(fact.conditions);
}
