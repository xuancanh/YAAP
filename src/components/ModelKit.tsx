/**
 * The small parts of automatic model selection on screen (docs/agent-types.md
 * "Model selection"): a tier badge (one, two or three bars), the mode switch
 * (Inherit / Auto / Fixed) and a run's decision line — "Auto · Strong ·
 * claude-opus-5-5" — whose reasons open on demand. Styles: models.css.
 */
import { useId, useState } from 'react';
import type { ModelDecision, ModelTierName } from '../lib/api';
import { MODEL_MODE_SHORT, TIER_HINT, TIER_LABEL, splitReasons } from '../lib/model-selection';
import '../styles/company.css';
import '../styles/models.css';

const LEVEL: Record<string, number> = { cheap: 1, standard: 2, strong: 3 };

/** A tier as three signal bars and its word. */
export function TierBadge({ tier, bare, title }: { tier: ModelTierName | string; bare?: boolean; title?: string }) {
  const n = LEVEL[tier] ?? 0;
  return (
    <span className={`ms-tier t-${tier}${bare ? ' bare' : ''}`} title={title ?? TIER_HINT[tier as ModelTierName]} data-tier={tier}>
      <svg width="11" height="10" viewBox="0 0 11 10" aria-hidden>
        {[0, 1, 2].map((i) => <rect key={i} x={i * 4} y={6 - i * 3} width="3" height={4 + i * 3} rx="0.8" className={i < n ? 'on' : ''} />)}
      </svg>
      {!bare && (TIER_LABEL[tier as ModelTierName] ?? tier)}
    </span>
  );
}

/** Inherit / Auto / Fixed as a segmented switch (a radio group). `options`
 *  limits the choices — the workspace has no Inherit. */
export function ModeSwitch({ value, onChange, label, options = ['', 'auto', 'fixed'], inheritLabel, disabled }: { value: string; onChange: (v: string) => void; label: string; options?: string[]; inheritLabel?: string; disabled?: boolean }) {
  return (
    <div className="co-seg ms-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o || 'inherit'} type="button" role="radio" aria-checked={value === o} aria-pressed={value === o} disabled={disabled}
          onClick={() => { if (value !== o) onChange(o); }}>
          {o === '' && inheritLabel ? inheritLabel : MODEL_MODE_SHORT[o] ?? o}
        </button>
      ))}
    </div>
  );
}

/** A run's or turn's automatic model decision: one compact line, the
 *  reasons behind "why". */
export function ModelDecisionLine({ d, testid = 'run-model-decision', compact }: { d: ModelDecision; testid?: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const { signals, scoreLine, adjustments } = splitReasons(d);
  return (
    <div className={`ms-decision${compact ? ' compact' : ''}`} data-testid={testid}>
      <div className="ms-decision-line">
        <span className="ms-auto">Auto</span>
        <TierBadge tier={d.tier} />
        <span className="ms-model">{d.model}</span>
        {d.requested && <span className="co-faint">· asked for {d.requested.tier}</span>}
        <button type="button" className="co-link ms-why" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
          {open ? 'Hide why' : 'Why this model'}
        </button>
      </div>
      {open && (
        <div className="ms-why-body" id={id}>
          <div className="ms-why-head">
            Complexity score <b className="co-num">{d.score}</b>
            {scoreLine && <span className="co-faint"> {scoreLine.replace(/^score -?\d+ /, '')}</span>}
          </div>
          {signals.length > 0 && (
            <ul className="ms-signals" aria-label="What the score counted">
              {signals.map((s, i) => <li key={i}><span className={`ms-n${s.n < 0 ? ' neg' : ''}`}>{s.n > 0 ? `+${s.n}` : s.n}</span>{s.text}</li>)}
            </ul>
          )}
          {adjustments.length > 0 && (
            <ul className="ms-adjust" aria-label="Then">
              {adjustments.map((x, i) => <li key={i}>{x}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
