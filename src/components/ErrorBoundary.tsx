import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  message: string | null;
}

/** Last line of defense: a parser bug should show a message, never a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.warn("Realm Guard hit an unexpected error", error, info.componentStack);
  }

  override render() {
    if (this.state.message === null) return this.props.children;
    return (
      <main className="mx-auto max-w-[640px] px-5 py-16">
        <h1 className="text-[28px] font-semibold">Something in those files tripped up Realm Guard</h1>
        <p className="mt-3 text-[15px] text-body">Nothing was sent anywhere. Reload the page and try again, and if it happens with the same files, please open an issue with the message below.</p>
        <pre className="mt-4 overflow-x-auto rounded-lg border border-rule bg-wash p-3 font-mono text-[12.5px] text-ink">{this.state.message}</pre>
        <button type="button" onClick={() => { window.location.reload(); }} className="mt-5 inline-flex h-9 items-center rounded-lg bg-action px-3 text-[14px] font-medium text-action-ink">
          Reload
        </button>
      </main>
    );
  }
}
