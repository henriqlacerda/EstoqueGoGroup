export const runtime = "nodejs";

type Action = "comprar" | "manter" | "liquidar" | "revisar";
type SkuSummary = {
  sku: string;
  status: "ativo" | "descontinuado";
  demandMean: number;
  position: number;
  reorderPoint: number;
  targetLevel: number;
  suggestedUnits: number;
  fundedUnits: number;
  coverageDays: number;
  unmetUnits: number;
  endingStock: number;
  endingCoverageDays: number | null;
  excess365Value: number;
  unitCost: number;
  liquidationAllowed: boolean;
  liquidationPrice: number | null;
  deterministicAction: Action;
  deterministicReason: string;
};
type Decision = { sku: string; action: Action; justification: string; fallback: boolean };

const allowedKeys = new Set([
  "sku", "status", "demandMean", "position", "reorderPoint", "targetLevel", "suggestedUnits",
  "fundedUnits", "coverageDays", "unmetUnits", "endingStock", "endingCoverageDays", "excess365Value",
  "unitCost", "liquidationAllowed", "liquidationPrice", "deterministicAction", "deterministicReason",
]);
const actions = new Set<Action>(["comprar", "manter", "liquidar", "revisar"]);

function deterministic(row: SkuSummary, fallback = true): Decision {
  return { sku: row.sku, action: row.deterministicAction, justification: row.deterministicReason, fallback };
}

function reviewRule(row: SkuSummary): string | null {
  if (row.status === "ativo" && row.endingCoverageDays !== null && row.endingCoverageDays > 365) return "[R1] cobertura final > 365 dias.";
  if (row.status === "ativo" && row.demandMean <= 0) return "[R2] sem venda na janela base.";
  if (row.status === "ativo" && row.suggestedUnits > 0 && row.fundedUnits <= 0) return "[R3] pedido calculado sem unidades financiadas.";
  if (row.status === "ativo" && row.unmetUnits > 0 && row.fundedUnits <= 0) return "[R4] demanda não atendida sem pedido financiado.";
  return null;
}

function fallback(rows: SkuSummary[], status: string) {
  return Response.json({ source: "fallback", fallback: true, status, decisions: rows.map((row) => deterministic(row)) });
}

function validSummary(value: unknown): value is SkuSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== allowedKeys.size || Object.keys(row).some((key) => !allowedKeys.has(key))) return false;
  if (typeof row.sku !== "string" || !["ativo", "descontinuado"].includes(String(row.status))) return false;
  if (!actions.has(row.deterministicAction as Action) || typeof row.deterministicReason !== "string" ||
    typeof row.liquidationAllowed !== "boolean") return false;
  const nullableNumbers = new Set(["endingCoverageDays", "liquidationPrice"]);
  for (const key of allowedKeys) {
    if (["sku", "status", "deterministicAction", "deterministicReason", "liquidationAllowed"].includes(key)) continue;
    const field = row[key];
    if (nullableNumbers.has(key) && field === null) continue;
    if (typeof field !== "number" || !Number.isFinite(field)) return false;
  }
  return true;
}

function parseModelDecisions(content: unknown, rows: SkuSummary[]): Decision[] | null {
  if (typeof content !== "string") return null;
  try {
    const parsed = JSON.parse(content) as { decisions?: unknown };
    if (!parsed || !Array.isArray(parsed.decisions) || parsed.decisions.length !== rows.length) return null;
    const expected = new Set(rows.map((row) => row.sku));
    const decisions: Decision[] = [];
    for (const item of parsed.decisions) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const value = item as Record<string, unknown>;
      if (Object.keys(value).length !== 3 || typeof value.sku !== "string" || !expected.has(value.sku) ||
        !actions.has(value.action as Action) || typeof value.justification !== "string" || !value.justification.trim()) return null;
      expected.delete(value.sku);
      decisions.push({ sku: value.sku, action: value.action as Action, justification: value.justification.trim().slice(0, 400), fallback: false });
    }
    if (expected.size) return null;
    const bySku = new Map(rows.map((row) => [row.sku, row]));
    return decisions.map((decision) => {
      const row = bySku.get(decision.sku)!;
      const violatesRule = row.status === "descontinuado"
        ? decision.action === "comprar" || (decision.action === "liquidar" && !row.liquidationAllowed)
        : decision.action === "liquidar" || (row.endingCoverageDays !== null && row.endingCoverageDays > 365 && decision.action !== "revisar") ||
          (decision.action === "comprar" && row.fundedUnits <= 0);
      if (violatesRule) return deterministic(row);
      if (decision.action !== "revisar") return decision;
      const rule = reviewRule(row);
      if (!rule) return deterministic(row);
      const justification = decision.justification.replace(/^\[R[1-4]\]\s*/, "");
      return { ...decision, justification: `${rule} ${justification}`.trim() };
    });
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const bodyText = await request.text();
  if (bodyText.length > 30_000) return Response.json({ error: "O lote de resumos excede o limite permitido." }, { status: 413 });
  let payload: { selectedSkus?: unknown };
  try { payload = JSON.parse(bodyText) as { selectedSkus?: unknown }; }
  catch { return Response.json({ error: "JSON inválido." }, { status: 400 }); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== 1 ||
    !Array.isArray(payload.selectedSkus) || payload.selectedSkus.length !== 10) {
    return Response.json({ error: "Envie exatamente 10 resumos de SKU por chamada." }, { status: 400 });
  }
  if (!payload.selectedSkus.every(validSummary)) {
    return Response.json({ error: "A rota aceita somente resumos estruturados, nunca linhas ou arquivos CSV." }, { status: 400 });
  }
  const rows = payload.selectedSkus;
  if (new Set(rows.map((row) => row.sku)).size !== rows.length) return Response.json({ error: "Os 10 SKUs precisam ser distintos." }, { status: 400 });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return fallback(rows, "GROQ_API_KEY ausente; decisões determinísticas aplicadas.");

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
        temperature: 0,
        max_completion_tokens: 2_000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Você recomenda ações de estoque a partir de resumos. Responda somente JSON no formato {\"decisions\":[{\"sku\":string,\"action\":\"comprar\"|\"manter\"|\"liquidar\"|\"revisar\",\"justification\":string}]}. Não sugira nem altere quantidades; suggestedUnits e fundedUnits vêm da política determinística. Só liquide status descontinuado com liquidationAllowed=true. Ativo com endingCoverageDays acima de 365 deve receber revisar, nunca liquidar. Compra só quando fundedUnits>0. Para todos os outros, use a ação determinística como referência." },
          { role: "user", content: JSON.stringify({ skus: rows }) },
        ],
      }),
    });
    if (!response.ok) return fallback(rows, `Groq indisponível (${response.status}); decisões determinísticas aplicadas.`);
    const completion = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const decisions = parseModelDecisions(completion.choices?.[0]?.message?.content, rows);
    if (!decisions) return fallback(rows, "Resposta do agente inválida; decisões determinísticas aplicadas.");
    return Response.json({ source: "groq", fallback: decisions.some((decision) => decision.fallback), decisions });
  } catch {
    return fallback(rows, "Falha na chamada ao Groq; decisões determinísticas aplicadas.");
  }
}
