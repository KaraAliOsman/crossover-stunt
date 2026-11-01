export declare const MOTION: Readonly<{
  enter: number;
  exit: number;
  content: number;
  roll: number;
  progress: number;
  count: number;
  stagger: number;
}>;
export declare function bezierLut(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): (t: number) => number;
export declare const EASE_OUT: (t: number) => number;
export declare const EASE_IN_OUT: (t: number) => number;
export declare function wavePose(elapsed: number, reduced?: boolean): number;
