export interface Cutout {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}
export declare function parseCutout(raw: unknown): Cutout | null;
export declare function readLayout(query: { get(name: string): string | null }): {
  readonly fit: 'full' | 'seam';
  readonly scale: number;
  readonly cutout: Cutout | null;
};
