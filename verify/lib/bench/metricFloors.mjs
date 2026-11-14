// Only reviewed, compiled floors belong here, keyed by metric id + definition hash.
// A new definition first RECORDS a20+20 opening block under session bounds1–5;
// it is never compared with itself. vr-lead amends the recorded floor after that
// window; a later commit adds its value here. The old Open Vault9.048pp floor
// applies to a RETIRED definition and is deliberately not reused for note open.
export const metricFloors = Object.freeze({});
