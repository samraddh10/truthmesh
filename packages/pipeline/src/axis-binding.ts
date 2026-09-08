export interface Positioned {
  readonly text: string;
  readonly centerX: number;
}

export interface Binding<L extends Positioned, V extends Positioned> {
  readonly value: V;
  readonly label: L | null;
  readonly deltaX: number;
  readonly ambiguous: boolean;
  readonly reason: string | null;
}

const MAX_DELTA_AS_PITCH_FRACTION = 0.5;

const MIN_SEPARATION_AS_PITCH_FRACTION = 0.25;

export function columnPitch(labels: readonly Positioned[]): number | null {
  if (labels.length < 2) return null;

  const centers = labels.map((label) => label.centerX).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < centers.length; i += 1) {
    gaps.push((centers[i] ?? 0) - (centers[i - 1] ?? 0));
  }

  gaps.sort((a, b) => a - b);
  const middle = Math.floor(gaps.length / 2);
  const pitch =
    gaps.length % 2 === 1
      ? (gaps[middle] ?? 0)
      : ((gaps[middle - 1] ?? 0) + (gaps[middle] ?? 0)) / 2;

  return pitch > 0 ? pitch : null;
}

export function bindToAxisLabels<L extends Positioned, V extends Positioned>(
  values: readonly V[],
  labels: readonly L[],
): Binding<L, V>[] {
  if (labels.length === 0) {
    return values.map((value) => ({
      value,
      label: null,
      deltaX: Number.POSITIVE_INFINITY,
      ambiguous: true,
      reason: 'no axis labels were found on this page',
    }));
  }

  const pitch = columnPitch(labels);

  return values.map((value) => {
    const ranked = labels
      .map((label) => ({ label, deltaX: Math.abs(value.centerX - label.centerX) }))
      .sort((a, b) => a.deltaX - b.deltaX);

    const nearest = ranked[0];
    if (nearest === undefined) {
      return { value, label: null, deltaX: Number.POSITIVE_INFINITY, ambiguous: true, reason: 'no axis labels were found on this page' };
    }

    if (pitch === null) {
      return {
        value,
        label: nearest.label,
        deltaX: nearest.deltaX,
        ambiguous: true,
        reason: 'only one axis label was found, so column spacing could not be established',
      };
    }

    if (nearest.deltaX > pitch * MAX_DELTA_AS_PITCH_FRACTION) {
      return {
        value,
        label: null,
        deltaX: nearest.deltaX,
        ambiguous: true,
        reason: `nearest label ${JSON.stringify(nearest.label.text)} is ${nearest.deltaX.toFixed(1)}pt away, more than half the ${pitch.toFixed(1)}pt column pitch`,
      };
    }

    const runnerUp = ranked[1];
    if (runnerUp !== undefined && runnerUp.deltaX - nearest.deltaX < pitch * MIN_SEPARATION_AS_PITCH_FRACTION) {
      return {
        value,
        label: null,
        deltaX: nearest.deltaX,
        ambiguous: true,
        reason: `value sits between ${JSON.stringify(nearest.label.text)} and ${JSON.stringify(runnerUp.label.text)}, ${nearest.deltaX.toFixed(1)}pt and ${runnerUp.deltaX.toFixed(1)}pt away`,
      };
    }

    return { value, label: nearest.label, deltaX: nearest.deltaX, ambiguous: false, reason: null };
  });
}
