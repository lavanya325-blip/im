export class NumberFormat {
  private static readonly prefixByExp: Record<number, string> = {
    [-15]: 'f',
    [-12]: 'p',
    [-9]: 'n',
    [-6]: 'µ',
    [-3]: 'm',
    [0]: '',
    [3]: 'k',
    [6]: 'M',
    [9]: 'G',
    [12]: 'T'
  };

  static toEngineeringNotation(value: number, digits = 3): string {
    if (value == null || Number.isNaN(value)) {
      return 'NaN';
    }
    if (!Number.isFinite(value)) {
      return value > 0 ? 'Infinity' : '-Infinity';
    }

    const sign = value < 0 ? '-' : '';
    const abs = Math.abs(value);
    if (abs === 0) {
      return (0).toFixed(digits);
    }

    let exp = Math.floor(Math.log10(abs) / 3) * 3;
    exp = Math.min(12, Math.max(-15, exp));
    const scaled = abs / Math.pow(10, exp);
    const prefix = NumberFormat.prefixByExp[exp] ?? `e${exp}`;
    return `${sign}${scaled.toFixed(digits)}${prefix}`;
  }
}
