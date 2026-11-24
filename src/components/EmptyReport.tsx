import { CHECKS } from "../content/copy";
import type { Sample } from "../samples";
import { Button, Eyebrow, Panel } from "./ui";

export function EmptyReport({ samples, onSample }: { samples: Sample[]; onSample: (s: Sample) => void }) {
  return (
    <Panel className="p-5 sm:p-6" labelledBy="checks-heading">
      <div id="checks" className="scroll-mt-6">
        <Eyebrow>Nothing scanned yet</Eyebrow>
        <h2 id="checks-heading" className="mt-2 text-[22px] font-semibold leading-8 tracking-[-0.01em]">
          What Realm Guard checks
        </h2>
        <p className="mt-1 text-[15px] text-body">Four ways a multi-client workflow ends up in the wrong client's books.</p>
      </div>
      <ol className="mt-5 grid gap-px overflow-hidden rounded-lg border border-rule bg-rule sm:grid-cols-2">
        {CHECKS.map((c, i) => (
          <li key={c.category} className="bg-panel p-4">
            <p className="font-mono text-[11px] text-faint">0{i + 1}</p>
            <h3 className="mt-1 text-[15px] font-semibold">{c.title}</h3>
            <p className="mt-1 text-[14px] leading-6 text-body">{c.body}</p>
          </li>
        ))}
      </ol>
      <div className="mt-5 flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <p className="text-[14px] text-muted">No workflow handy?</p>
        <div className="flex flex-wrap gap-2">
          {samples.map((s, i) => (
            <Button key={s.id} variant={i === 0 ? "primary" : "secondary"} onClick={() => {
              onSample(s);
            }}>
              {i === 0 ? `Try the ${s.label.toLowerCase()}` : s.label}
            </Button>
          ))}
        </div>
      </div>
    </Panel>
  );
}

export function InputProblem({ title, messages }: { title: string; messages: string[] }) {
  return (
    <Panel className="p-5 sm:p-6" labelledBy="problem-heading">
      <Eyebrow>Can't scan yet</Eyebrow>
      <h2 id="problem-heading" className="mt-2 text-[22px] font-semibold leading-8">
        {title}
      </h2>
      <ul className="mt-3 space-y-1.5 text-[14px] leading-6 text-body">
        {messages.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
      <p className="mt-4 text-[13px] text-muted">The report appears as soon as both files read cleanly.</p>
    </Panel>
  );
}
