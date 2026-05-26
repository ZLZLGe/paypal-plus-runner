export class WindowPool {
  constructor({ windows = [] } = {}) {
    this.windows = windows;
  }

  add(windowInfo) {
    this.windows.push(windowInfo);
  }

  all() {
    return [...this.windows];
  }
}
