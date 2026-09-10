declare module 'jsdom' {
  export class JSDOM {
    constructor(html: string, opts?: Record<string, unknown>);
    window: Window & typeof globalThis;
  }
  export type DOMWindow = Window & typeof globalThis;
}
