declare module "guacamole-common-js" {
  export class Client {
    constructor(tunnel: Tunnel);
    connect(data?: string): void;
    disconnect(): void;
    sendMouseState(state: Mouse.State): void;
    sendKeyEvent(pressed: number, keysym: number): void;
    getDisplay(): Display;
    onstatechange: ((state: number) => void) | null;
    onerror: ((status: Status) => void) | null;
  }

  export class Display {
    getElement(): HTMLElement;
    scale(scale: number): void;
  }

  export class Tunnel {
    constructor();
  }

  export class WebSocketTunnel extends Tunnel {
    constructor(url: string);
  }

  export class HTTPTunnel extends Tunnel {
    constructor(url: string);
  }

  export namespace Mouse {
    interface State {
      x: number;
      y: number;
      left: boolean;
      middle: boolean;
      right: boolean;
      up: boolean;
      down: boolean;
    }
    interface Event {
      state: State;
    }
  }

  export class Mouse {
    constructor(element: HTMLElement);
    onEach(events: string[], handler: (e: Mouse.Event) => void): void;
    onmousedown: ((state: Mouse.State) => void) | null;
    onmouseup: ((state: Mouse.State) => void) | null;
    onmousemove: ((state: Mouse.State) => void) | null;
  }

  export class Keyboard {
    constructor(element: HTMLElement | Document);
    onkeydown: ((keysym: number) => boolean | void) | null;
    onkeyup: ((keysym: number) => void) | null;
  }

  export class Status {
    code: number;
    message: string;
  }
}
