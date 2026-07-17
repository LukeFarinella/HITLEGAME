// world-atlas ships raw TopoJSON; we only need it as data.
declare module 'world-atlas/land-110m.json' {
  const value: {
    type: string;
    arcs: number[][][];
    transform?: { scale: [number, number]; translate: [number, number] };
    objects: { land: unknown };
  };
  export default value;
}
