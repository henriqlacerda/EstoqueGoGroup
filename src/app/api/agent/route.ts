const allowedKeys = new Set([
  "sku", "status", "demandMean", "position", "reorderPoint", "targetLevel", "suggestedUnits",
  "fundedUnits", "coverageDays", "unmetUnits",
]);

type SkuSummary = {
  sku: string;
  status: string;
  demandMean: number;
  position: number;
  reorderPoint: number;
  targetLevel: number;
  suggestedUnits: number;
  fundedUnits: number;
  coverageDays: number;
  unmetUnits: number;
};

export async function POST(request: Request) {
  const bodyText = await request.text();
  if (bodyText.length > 80_000) return Response.json({ error: "O resumo excede o limite permitido." }, { status: 413 });
  let payload: { selectedSkus?: unknown };
  try { payload = JSON.parse(bodyText) as { selectedSkus?: unknown }; }
  catch { return Response.json({ error: "JSON inválido." }, { status: 400 }); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== 1 ||
    !Array.isArray(payload.selectedSkus) || payload.selectedSkus.length !== 30) {
    return Response.json({ error: "Envie exatamente 30 resumos de SKU." }, { status: 400 });
  }
  const summaries: SkuSummary[] = [];
  for (const value of payload.selectedSkus) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return Response.json({ error: "Formato de resumo inválido." }, { status: 400 });
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some((key) => !allowedKeys.has(key)) || Object.keys(row).length !== allowedKeys.size) {
      return Response.json({ error: "A rota aceita apenas campos de resumo, nunca linhas ou arquivos CSV." }, { status: 400 });
    }
    if (typeof row.sku !== "string" || !["ativo", "descontinuado"].includes(String(row.status)) ||
      [...allowedKeys].filter((key) => key !== "sku" && key !== "status").some((key) => typeof row[key] !== "number" || !Number.isFinite(row[key]))) {
      return Response.json({ error: "Campos de resumo inválidos." }, { status: 400 });
    }
    summaries.push(row as unknown as SkuSummary);
  }
  if (new Set(summaries.map((row) => row.sku)).size !== 30) return Response.json({ error: "Os 30 SKUs precisam ser distintos." }, { status: 400 });
  const atRisk = summaries.filter((row) => row.unmetUnits > 0 || row.position <= row.reorderPoint).length;
  return Response.json({ received: summaries.length, atRisk });
}
