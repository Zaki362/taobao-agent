export const API_INPUT_LIMITS = {
  defaultBodyBytes: 64 * 1024,
  executorBodyBytes: 512 * 1024,
  sceneInputLength: 4_000,
  optionalNotesLength: 1_000,
  sceneLabelLength: 120,
  sceneListItems: 20,
  sceneListItemLength: 100,
  keywordLength: 80,
  alternateKeywords: 10,
  budgetMin: 1,
  budgetMax: 10_000_000
} as const;
