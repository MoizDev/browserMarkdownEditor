let docSeq = 0;
export function newTabId(): string {
  return `d${(++docSeq).toString(36)}`;
}
