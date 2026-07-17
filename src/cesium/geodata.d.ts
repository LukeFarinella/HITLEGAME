// TopoJSON data modules — typed loosely; we run them through topojson-client at runtime.
declare module 'world-atlas/countries-10m.json' {
  const value: { type: string; arcs: unknown; transform?: unknown; objects: { countries: unknown } };
  export default value;
}
declare module 'world-atlas/countries-50m.json' {
  const value: { type: string; arcs: unknown; transform?: unknown; objects: { countries: unknown } };
  export default value;
}
declare module 'us-atlas/states-10m.json' {
  const value: { type: string; arcs: unknown; transform?: unknown; objects: { states: unknown } };
  export default value;
}
declare module 'world-atlas/land-10m.json' {
  const value: { type: string; arcs: unknown; transform?: unknown; objects: { land: unknown } };
  export default value;
}
