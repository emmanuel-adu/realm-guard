import { FilePlus2, Lock } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { EmptyReport, InputProblem } from "./components/EmptyReport";
import { Header, type Theme } from "./components/Header";
import { Report } from "./components/Report";
import { type Source, SourceCard } from "./components/SourceCard";
import { Button, Eyebrow } from "./components/ui";
import { INPUTS, INTRO, REPO_URL } from "./content/copy";
import { draftManifest, parseWorkflow, scanText } from "./engine";
import { SAMPLES, type Sample } from "./samples";

function readTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function App() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [workflow, setWorkflow] = useState<Source | null>(null);
  const [manifest, setManifest] = useState<Source | null>(null);
  const workflowText = useDeferredValue(workflow?.text ?? "");
  const manifestText = useDeferredValue(manifest?.text ?? "");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("rg-theme", theme);
    } catch {
      // Storage can be unavailable in private windows and sandboxed previews.
    }
  }, [theme]);

  const result = useMemo(() => (workflowText.trim() ? scanText(workflowText, manifestText) : null), [workflowText, manifestText]);
  const parsedWorkflow = useMemo(() => {
    const r = workflowText.trim() ? parseWorkflow(workflowText) : null;
    return r?.ok ? r.value : null;
  }, [workflowText]);

  const workflowErrors = result && !result.ok ? result.errors.filter((e) => e.source === "workflow").map((e) => e.message) : [];
  const manifestErrors = result && !result.ok ? result.errors.filter((e) => e.source === "manifest").map((e) => e.message) : [];
  const warnings = result?.ok ? result.warnings : [];

  const loadSample = (s: Sample) => {
    setWorkflow({ text: s.workflow, label: s.workflowFile, origin: "sample" });
    setManifest({ text: s.manifest, label: s.manifestFile, origin: "sample" });
    requestAnimationFrame(() => {
      document.getElementById("report-start")?.focus({ preventScroll: true });
      if (window.matchMedia("(max-width: 1023px)").matches) document.getElementById("report-start")?.scrollIntoView({ block: "start" });
    });
  };

  const summary = parsedWorkflow ? `${parsedWorkflow.name} · ${String(parsedWorkflow.nodes.length)} nodes` : undefined;

  return (
    <div id="top" className="min-h-dvh bg-canvas">
      <Header
        theme={theme}
        onToggleTheme={() => {
          setTheme((t) => (t === "dark" ? "light" : "dark"));
        }}
      />
      <main className="mx-auto max-w-[1200px] px-5 pb-16 md:px-8">
        <div className="max-w-[720px] pt-10 pb-8 md:pt-14 md:pb-10">
          <Eyebrow>{INTRO.eyebrow}</Eyebrow>
          <h1 className="mt-3 text-[32px] font-semibold leading-[38px] tracking-[-0.02em] sm:text-[40px] sm:leading-[46px]">{INTRO.title}</h1>
          <p className="mt-3 text-[16px] leading-7 text-body sm:text-[17px]">{INTRO.lead}</p>
          <p className="mt-4 inline-flex items-center gap-2 rounded-md border border-rule bg-wash px-2.5 py-1 font-mono text-[12px] text-muted">
            <Lock className="size-3.5" aria-hidden="true" />
            {INTRO.privacy}
          </p>
        </div>

        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[380px_minmax(0,1fr)] lg:gap-8">
          <aside className="min-w-0 space-y-6 lg:sticky lg:top-6" aria-label="Inputs">
            <SourceCard
              id="workflow"
              label={INPUTS.workflow.label}
              hint={INPUTS.workflow.hint}
              drop={INPUTS.workflow.drop}
              accept={INPUTS.workflow.accept}
              placeholder={INPUTS.workflow.pastePlaceholder}
              value={workflow}
              onChange={setWorkflow}
              errors={workflowErrors}
              summary={summary}
            />
            <div className="border-t border-rule" />
            <SourceCard
              id="manifest"
              label={INPUTS.manifest.label}
              optional={INPUTS.manifest.optional}
              hint={INPUTS.manifest.hint}
              drop={INPUTS.manifest.drop}
              accept={INPUTS.manifest.accept}
              placeholder={INPUTS.manifest.pastePlaceholder}
              value={manifest}
              onChange={setManifest}
              errors={manifestErrors}
              editable
              actions={
                parsedWorkflow && !manifest ? (
                  <Button
                    variant="quiet"
                    className="-my-1 h-8 px-2 text-[13px]"
                    onClick={() => {
                      setManifest({ text: draftManifest(parsedWorkflow), label: "clients.yaml (draft)", origin: "draft" });
                    }}
                  >
                    <FilePlus2 className="size-3.5" aria-hidden="true" />
                    {INPUTS.manifest.draft}
                  </Button>
                ) : null
              }
              footnote={
                !manifest && parsedWorkflow ? <p className="text-[13px] leading-5 text-muted">{INPUTS.manifest.without}</p> : null
              }
            />
            {warnings.length > 0 ? (
              <ul className="space-y-1 rounded-lg border border-rule bg-wash px-3 py-2 text-[13px] leading-5 text-body" aria-label="Warnings">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            ) : null}
            <div className="border-t border-rule pt-5">
              <p className="text-[13px] font-medium text-ink">Try a sample</p>
              <ul className="mt-2 space-y-1">
                {SAMPLES.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => {
                        loadSample(s);
                      }}
                      className="group w-full rounded-lg px-2.5 py-2 text-left hover:bg-wash"
                    >
                      <span className="block text-[14px] font-medium text-ink group-hover:underline group-hover:underline-offset-2">{s.label}</span>
                      <span className="block text-[13px] leading-5 text-muted">{s.blurb}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </aside>

          <section aria-label="Report" className="min-w-0">
            <div id="report-start" tabIndex={-1} className="scroll-mt-4 outline-none" />
            <div aria-live="polite" className="sr-only">
              {result?.ok ? `Scan finished: ${String(result.report.findings.length)} findings.` : ""}
            </div>
            {!result ? (
              <EmptyReport samples={SAMPLES} onSample={loadSample} />
            ) : result.ok ? (
              <Report report={result.report} />
            ) : (
              <InputProblem
                title={workflowErrors.length > 0 ? "The workflow file didn't read cleanly" : "The manifest has a problem"}
                messages={[...workflowErrors, ...manifestErrors]}
              />
            )}
          </section>
        </div>
      </main>
      <footer className="border-t border-rule">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-2 px-5 py-6 text-[13px] text-muted sm:flex-row sm:items-center sm:justify-between md:px-8">
          <p>Realm Guard is open source under the MIT license. Sample clients and IDs are made up.</p>
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="text-ink underline underline-offset-2">
            Rules and source on GitHub
          </a>
        </div>
      </footer>
    </div>
  );
}
