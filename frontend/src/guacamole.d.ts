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
    getWidth(): number;
    getHeight(): number;
    onresize: ((width: number, height: number) => void) | null;
  }

  /** Tunnel reading a whole Guacamole dump over plain HTTP GET (works with blob: URLs). */
  export class StaticHTTPTunnel extends Tunnel {
    constructor(url: string, crossDomain?: boolean, extraTunnelHeaders?: Record<string, string>);
  }

  /** Playback of a recorded Guacamole protocol dump (Blob or tunnel source). */
  export class SessionRecording {
    constructor(source: Blob | Tunnel);
    connect(data?: string): void;
    disconnect(): void;
    abort(): void;
    getDisplay(): Display;
    isPlaying(): boolean;
    getPosition(): number;
    getDuration(): number;
    play(): void;
    pause(): void;
    seek(position: number, callback?: () => void): void;
    cancel(): void;
    onload: (() => void) | null;
    onerror: ((message: string) => void) | null;
    onabort: (() => void) | null;
    onprogress: ((duration: number, parsedSize: number) => void) | null;
    onplay: (() => void) | null;
    onpause: (() => void) | null;
    onseek: ((position: number, current: number, total: number) => void) | null;
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
    class State {
      constructor(
        x: number,
        y: number,
        left: boolean,
        middle: boolean,
        right: boolean,
        up: boolean,
        down: boolean
      );
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
