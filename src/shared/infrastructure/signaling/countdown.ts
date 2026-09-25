export class Countdown {
  private timeout?: ReturnType<typeof setTimeout>;

  public constructor(private readonly onExpired?: () => void) {}

  public start(duration: number): void {
    this.stop();

    this.timeout = setTimeout(() => {
      this.timeout = undefined;
      this.onExpired?.();
    }, duration);
  }

  public reset(duration: number): void {
    this.start(duration);
  }

  public stop(): void {
    if (!this.timeout) {
      return;
    }

    clearTimeout(this.timeout);
    this.timeout = undefined;
  }

  public isRunning(): boolean {
    return this.timeout !== undefined;
  }
}
