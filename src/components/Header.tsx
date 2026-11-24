import { ArrowUpRight, Moon, Sun } from "lucide-react";
import { REPO_URL } from "../content/copy";
import { Mark } from "./ui";

export type Theme = "light" | "dark";

export function Header({ theme, onToggleTheme }: { theme: Theme; onToggleTheme: () => void }) {
  const next = theme === "dark" ? "light" : "dark";
  return (
    <header className="border-b border-rule">
      <div className="mx-auto flex h-14 max-w-[1200px] items-center justify-between px-5 md:px-8">
        <a href="#top" className="flex items-center gap-2.5 rounded-md text-[15px] font-semibold text-ink">
          <Mark className="size-6" />
          Realm Guard
        </a>
        <nav className="flex items-center gap-1" aria-label="Site">
          <a href="#checks" className="hidden h-9 items-center rounded-lg px-3 text-[14px] text-muted hover:text-ink sm:inline-flex">
            What it checks
          </a>
          <a href={REPO_URL} className="inline-flex h-9 items-center gap-1 rounded-lg px-3 text-[14px] text-muted hover:text-ink" target="_blank" rel="noreferrer">
            Source
            <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </a>
          <button
            type="button"
            onClick={onToggleTheme}
            aria-label={`Switch to ${next} theme`}
            className="inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-wash hover:text-ink"
          >
            {theme === "dark" ? <Sun className="size-4" aria-hidden="true" /> : <Moon className="size-4" aria-hidden="true" />}
          </button>
        </nav>
      </div>
    </header>
  );
}
