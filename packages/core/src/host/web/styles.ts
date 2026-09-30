/**
 * Changes inline declarations of an element and restores exactly what was
 * there before: value, priority and, when absent at first, the attribute.
 * Uses the CSSOM, which a `style-src 'self'` policy allows.
 */
export class InlineStyles {
  private readonly saved = new Map<string, readonly [value: string, priority: string]>();
  private readonly hadAttribute: boolean;

  constructor(private readonly element: HTMLElement) {
    this.hadAttribute = element.hasAttribute('style');
  }
  set(property: string, value: string): void {
    const style = this.element.style;
    if (!this.saved.has(property))
      this.saved.set(property, [
        style.getPropertyValue(property),
        style.getPropertyPriority(property),
      ]);
    if (style.getPropertyValue(property) !== value || style.getPropertyPriority(property) !== '')
      style.setProperty(property, value);
  }
  restore(): void {
    const style = this.element.style;
    for (const [property, [value, priority]] of this.saved) {
      if (value === '') style.removeProperty(property);
      else style.setProperty(property, value, priority);
    }
    this.saved.clear();
    if (!this.hadAttribute && style.length === 0) {
      // Chromium and WebKit serialize CSSOM changes into the attribute lazily; a
      // pending serialization would otherwise bring back an empty attribute.
      this.element.getAttribute('style');
      this.element.removeAttribute('style');
    }
  }
}
