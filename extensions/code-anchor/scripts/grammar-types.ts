export interface Grammar {
  name: string;
  crate: string;
  version: string;
  symbol: string;
  sha256: string;
  license: string;
  aliases: string[];
  extensions: string[];
  expando: string;
  requiresReferencePatch?: boolean;
}

export interface GrammarManifest {
  referenceRevision: string;
  treeSitter: string;
  grammars: Grammar[];
}

export interface GrammarSource {
  name: string;
  package: string;
  symbol: string;
  parser: string;
  scanner?: string;
  include: string[];
}
