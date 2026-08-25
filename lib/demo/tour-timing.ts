export const PUBLIC_DEMO_RESULTS_STEP_INDEX = 4;
export const PUBLIC_DEMO_RESULTS_SPEED_MULTIPLIER = 1.5;

export function pacePublicDemoTourDuration(duration: number, stepIndex: number) {
  if (stepIndex < PUBLIC_DEMO_RESULTS_STEP_INDEX) return duration;
  return Math.round(duration / PUBLIC_DEMO_RESULTS_SPEED_MULTIPLIER);
}
