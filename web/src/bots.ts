// Little robots that ride the live tip of each running lane. One look per model family; what
// they do (bob, tinker, glance, doze) follows the lane's state and is pure CSS (see index.html).
// Coordinates: origin at the top center, where the lane's tip is; the figure hangs below it.

export type Family = "opus" | "sonnet" | "haiku" | "claude";

export function familyOf(model: string | undefined): Family {
  const m = (model ?? "").toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return "claude";
}

const EYES = (y: number, gap = 3) =>
  `<rect class="bot-eye" x="${-gap - 1}" y="${y}" width="2" height="3" rx="1"/>` +
  `<rect class="bot-eye" x="${gap - 1}" y="${y}" width="2" height="3" rx="1"/>`;

const BODY = (top: number, w: number, h: number) =>
  `<rect class="bot-body" x="${-w / 2}" y="${top}" width="${w}" height="${h}" rx="2"/>` +
  `<rect class="bot-leg bot-leg-l" x="${-w / 2 + 1}" y="${top + h}" width="3" height="4" rx="1"/>` +
  `<rect class="bot-leg bot-leg-r" x="${w / 2 - 4}" y="${top + h}" width="3" height="4" rx="1"/>`;

const FIGURES: Record<Family, string> = {
  // Headphones: the one that's really vibing.
  opus: `
    <path class="bot-phones" d="M-10,11 A10,9 0 0 1 10,11"/>
    <rect class="bot-head" x="-9" y="5" width="18" height="13" rx="4"/>
    <rect class="bot-cup" x="-12" y="8" width="4" height="7" rx="1.5"/>
    <rect class="bot-cup" x="8" y="8" width="4" height="7" rx="1.5"/>
    <rect class="bot-face" x="-6.5" y="8" width="13" height="7" rx="2"/>${EYES(10)}
    ${BODY(19, 12, 8)}`,
  // A beret, tilted.
  sonnet: `
    <rect class="bot-head" x="-8" y="6" width="16" height="12" rx="4"/>
    <ellipse class="bot-beret" cx="-1" cy="6" rx="8.5" ry="3" transform="rotate(-10 -1 6)"/>
    <circle class="bot-beret" cx="-1" cy="2.6" r="1.3"/>
    <rect class="bot-face" x="-5.5" y="9" width="11" height="6.5" rx="2"/>${EYES(10.8, 2.6)}
    ${BODY(19, 11, 8)}`,
  // Small and round, with a sprout.
  haiku: `
    <path class="bot-stem" d="M0,6 Q0,3 1,1"/>
    <ellipse class="bot-leaf" cx="3.2" cy="1.2" rx="2.6" ry="1.3" transform="rotate(-25 3.2 1.2)"/>
    <circle class="bot-head" cx="0" cy="12" r="7"/>
    <rect class="bot-face" x="-4.5" y="9.5" width="9" height="5.5" rx="2.5"/>${EYES(10.8, 2)}
    ${BODY(19.5, 8, 6)}`,
  // Unknown model: the classic antenna bot.
  claude: `
    <line class="bot-antenna" x1="0" y1="1" x2="0" y2="5"/><circle class="bot-bulb" cx="0" cy="1.5" r="1.6"/>
    <rect class="bot-head" x="-8" y="5" width="16" height="12" rx="3"/>
    <rect class="bot-face" x="-5.5" y="8" width="11" height="6" rx="2"/>${EYES(9.5, 2.6)}
    ${BODY(18, 11, 8)}`,
};

// Props for every state live in the markup; CSS shows the ones that fit the current state.
export function botMarkup(family: Family): string {
  return `
    <g class="bot-figure">${FIGURES[family]}</g>
    <text class="bot-prop bot-note bot-note-1" x="11" y="6">♪</text>
    <text class="bot-prop bot-note bot-note-2" x="-16" y="4">♫</text>
    <text class="bot-prop bot-gear" x="11" y="21">⚙</text>
    <text class="bot-prop bot-z bot-z-1" x="9" y="6">z</text>
    <text class="bot-prop bot-z bot-z-2" x="13" y="1">z</text>
    <text class="bot-label" x="0" y="38">${family === "claude" ? "" : family}</text>`;
}
