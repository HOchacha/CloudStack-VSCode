/**
 * 확장 코드를 Node 에서 끝까지 돌려보기 위한 최소 `vscode` 모듈 대역.
 * 이 확장이 쓰는 API 만 구현하고, 사용자 응답은 테스트가 넣는 응답 함수로 정한다.
 * 실제 VS Code 동작(렌더링, Remote-SSH 연결)은 검증하지 않는다.
 */

type Responder<A extends any[], R> = (...args: A) => R;

export const recorded = {
  executed: [] as { id: string; args: any[] }[],
  messages: [] as { level: string; text: string; items: string[] }[],
  terminals: [] as any[],
  logs: [] as string[],
  clipboard: "",
  contexts: {} as Record<string, any>,
  treeProvider: undefined as any,
};

export const responders = {
  input: ((_o: any) => undefined) as Responder<[any], string | undefined>,
  quickPick: ((_items: any[], _o: any) => undefined) as Responder<[any[], any], any>,
  message: ((_level: string, _text: string, _items: string[]) => undefined) as Responder<[string, string, string[]], string | undefined>,
};

export const settings: Record<string, any> = {};
export const installedExtensions = new Set<string>();
const configListeners: ((e: any) => void)[] = [];
const commandRegistry = new Map<string, (...a: any[]) => any>();

export function resetRecorded(): void {
  recorded.executed.length = 0;
  recorded.messages.length = 0;
  recorded.terminals.length = 0;
}

const disposable = { dispose() {} };

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}
export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}
export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export class ThemeColor {
  constructor(public id: string) {}
}
export class ThemeIcon {
  constructor(public id: string, public color?: ThemeColor) {}
}
export class MarkdownString {
  isTrusted = false;
  constructor(public value = "", public supportThemeIcons = false) {}
  appendMarkdown(s: string) {
    this.value += s;
    return this;
  }
}
export class TreeItem {
  id?: string;
  description?: string;
  tooltip?: any;
  iconPath?: any;
  contextValue?: string;
  command?: any;
  constructor(public label: string, public collapsibleState = TreeItemCollapsibleState.None) {}
}
export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (l: (e: T) => void) => {
    this.listeners.push(l);
    return disposable;
  };
  fire(e?: T) {
    for (const l of this.listeners) l(e as T);
  }
  dispose() {}
}
export class Uri {
  private constructor(
    public scheme: string,
    public authority: string,
    public path: string
  ) {}
  get fsPath() {
    return this.path;
  }
  static file(p: string) {
    return new Uri("file", "", p);
  }
  static from(c: { scheme: string; authority?: string; path?: string }) {
    return new Uri(c.scheme, c.authority ?? "", c.path ?? "");
  }
  toString() {
    return `${this.scheme}://${this.authority}${this.path}`;
  }
}

async function validate(o: any, v: string | undefined) {
  if (v !== undefined && o?.validateInput) {
    const err = await o.validateInput(v);
    if (err) throw new Error(`테스트 입력이 검증에 걸림 (${o.title}): ${err}`);
  }
  return v;
}

function message(level: string) {
  return async (text: string, ...rest: any[]) => {
    const items = rest.filter((x) => typeof x === "string");
    recorded.messages.push({ level, text, items });
    return items.length ? responders.message(level, text, items) : undefined;
  };
}

export const window = {
  createOutputChannel: (_name: string, _o?: any) => {
    const push = (lvl: string) => (m: string) => recorded.logs.push(`[${lvl}] ${m}`);
    return { info: push("info"), warn: push("warn"), error: push("error"), debug: push("debug"), trace: push("trace"), appendLine: push("line"), dispose() {} };
  },
  createTreeView: (_id: string, o: any) => {
    recorded.treeProvider = o.treeDataProvider;
    return { visible: true, onDidChangeVisibility: () => disposable, dispose() {} };
  },
  showInputBox: async (o: any) => validate(o, responders.input(o)),
  showQuickPick: async (items: any, o: any) => responders.quickPick(await items, o),
  showInformationMessage: message("info"),
  showWarningMessage: message("warn"),
  showErrorMessage: message("error"),
  withProgress: async (_o: any, task: any) =>
    task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => disposable }),
  createTerminal: (o: any) => {
    recorded.terminals.push(o);
    return { show() {}, dispose() {} };
  },
  showOpenDialog: async () => undefined,
  showTextDocument: async () => undefined,
};

export const commands = {
  registerCommand: (id: string, fn: (...a: any[]) => any) => {
    commandRegistry.set(id, fn);
    return disposable;
  },
  executeCommand: async (id: string, ...args: any[]) => {
    const fn = commandRegistry.get(id);
    if (fn) return fn(...args);
    recorded.executed.push({ id, args });
    if (id === "setContext") recorded.contexts[args[0]] = args[1];
    return undefined;
  },
};

export const workspace = {
  getConfiguration: (section: string) => ({
    get: <T>(key: string, def?: T): T | undefined => {
      const v = settings[`${section}.${key}`];
      return v === undefined ? def : v;
    },
    update: async (key: string, value: any) => {
      const full = `${section}.${key}`;
      settings[full] = value;
      for (const l of configListeners) l({ affectsConfiguration: (s: string) => full.startsWith(s) });
    },
  }),
  onDidChangeConfiguration: (l: (e: any) => void) => {
    configListeners.push(l);
    return disposable;
  },
};

export const extensions = {
  getExtension: (id: string) => (installedExtensions.has(id) ? { id, packageJSON: {} } : undefined),
};

export const env = {
  clipboard: {
    writeText: async (t: string) => {
      recorded.clipboard = t;
    },
  },
};

export function makeContext() {
  const secrets = new Map<string, string>();
  const global = new Map<string, any>();
  return {
    subscriptions: [] as any[],
    secrets: {
      get: async (k: string) => secrets.get(k),
      store: async (k: string, v: string) => void secrets.set(k, v),
      delete: async (k: string) => void secrets.delete(k),
    },
    globalState: {
      get: (k: string, d?: any) => (global.has(k) ? global.get(k) : d),
      update: async (k: string, v: any) => void global.set(k, v),
    },
    _secrets: secrets,
  };
}
