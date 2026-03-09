import yoctoSpinner from "yocto-spinner";
import {
  bold,
  cyan,
  dim,
  green,
  red,
  yellow,
} from "yoctocolors";

export { bold, cyan, dim, green, red, yellow };

export interface Spinner {
  readonly isSpinning: boolean;
  start(text: string): void;
  update(text: string): void;
  success(text: string): void;
  error(text: string): void;
  warning(text: string): void;
  info(text: string): void;
  stop(): void;
}

export interface Logger {
  info(msg: string): void;
  error(msg: string): void;
}

export interface UI {
  readonly spinner: Spinner;
  readonly log: Logger;
}

function createSpinner(): Spinner {
  const instance = yoctoSpinner({ color: "cyan" });

  return {
    get isSpinning() {
      return instance.isSpinning;
    },
    start(text: string) {
      instance.start(text);
    },
    update(text: string) {
      instance.text = text;
    },
    success(text: string) {
      instance.success(text);
    },
    error(text: string) {
      instance.error(text);
    },
    warning(text: string) {
      instance.warning(text);
    },
    info(text: string) {
      instance.info(text);
    },
    stop() {
      if (instance.isSpinning) {
        instance.stop();
      }
    },
  };
}

function createLogger(spinner: Spinner): Logger {
  return {
    info(msg: string) {
      spinner.stop();
      process.stdout.write(`${msg}\n`);
    },
    error(msg: string) {
      spinner.stop();
      process.stderr.write(`${red(bold("error"))} ${msg}\n`);
    },
  };
}

export function createUI(): UI {
  const spinner = createSpinner();
  const log = createLogger(spinner);
  return { spinner, log };
}
