export interface Vec2 { readonly x: number; readonly y: number }
export type PathOp =
    | Readonly<{ op: 'M' | 'L'; p: Vec2 }>
    | Readonly<{ op: 'C'; c1: Vec2; c2: Vec2; p: Vec2 }>
    | Readonly<{ op: 'Z' }>;
export interface Cubic { readonly p0: Vec2; readonly p1: Vec2; readonly p2: Vec2; readonly p3: Vec2 }
export interface Arc { readonly centre: Vec2; readonly radius: number; readonly start: number; readonly sweep: number }
