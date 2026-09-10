/**
 * `cytoscape-dagre` ships no types. It is a Cytoscape extension registered with
 * `cytoscape.use`, so the shape that matters is just "a plugin function".
 */
declare module 'cytoscape-dagre' {
  const extension: cytoscape.Ext;
  export default extension;
}
