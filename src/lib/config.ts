export const CONFIG = {
  referenceDate: "2026-09-29",
  baseStart: "2026-07-02",
  baseEnd: "2026-09-29",
  horizonStart: "2026-10-01",
  horizonEnd: "2026-12-29",
  seasonalityBaseStart: "2025-07-02",
  seasonalityBaseEnd: "2025-09-29",
  campaigns: [
    { name: "Black Friday", start: "2026-11-20", end: "2026-11-30", sourceStart: "2025-11-20", sourceEnd: "2025-11-30" },
    { name: "Natal", start: "2026-12-01", end: "2026-12-22", sourceStart: "2025-12-01", sourceEnd: "2025-12-22" },
  ],
  targetDays: 30,
  openOrderMaxAgeDays: 90,
  budget: 1_970_000,
  monthlyHoldingRate: 0.027,
  serviceScenarios: [
    { service: 0.95, z: 1.645 },
    { service: 0.98, z: 2.054 },
    { service: 0.99, z: 2.326 },
  ],
  officialService: 0.98,
  caseUnits: 12,
} as const;
