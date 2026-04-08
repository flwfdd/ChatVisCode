declare module 'json-parse-even-better-errors' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function parse(json: string, reviver?: (key: any, value: any) => any, context?: number): any;
  export = parse;
}
