/** An SVG file imported as its text (`with { type: "text" }`), e.g. the agent's mark. */
declare module "*.svg" {
  const text: string;
  export default text;
}
