/** A template with its named slots filled in. */
export function fill(template, values) {
  let out = template;
  for (const [name, value] of Object.entries(values)) {
    out = out.replaceAll(`{${name}}`, value);
  }
  return out;
}
