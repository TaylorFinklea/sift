const activityOf = (run) => String(run.updatedAt || run.createdAt || "");

/**
 * Groups rounds by their sort session. A revised path is its own session, so it forms its own
 * group. Rounds inside a group are listed by round number, then creation time; rounds that share
 * a number are siblings and each keeps its own row and actions.
 */
export function groupRunsBySort(runs) {
  const groups = new Map();
  for (const run of runs) {
    const key = run.sortId || run.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  return [...groups.entries()]
    .map(([key, rounds]) => {
      const ordered = rounds.slice().sort((a, b) => (Number(a.roundNumber) || 1) - (Number(b.roundNumber) || 1)
        || String(a.createdAt).localeCompare(String(b.createdAt)));
      const latest = rounds.reduce((newest, run) => activityOf(run) > newest ? activityOf(run) : newest, "");
      return { key, rounds: ordered, latest };
    })
    .sort((a, b) => b.latest.localeCompare(a.latest));
}
