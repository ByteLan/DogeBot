export function randomItem<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

export function triggerDecision(rate: number) {
  const roll = Math.random();
  return { roll, triggered: rate > 0 && roll < rate };
}
