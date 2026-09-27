declare module 'html-encoding-sniffer' {
  /** Options verified against the pinned 6.0.0 package. */
  export default function sniffHtmlEncoding(
    bytes: Uint8Array,
    options?: {
      xml?: boolean;
      transportLayerEncodingLabel?: string;
      defaultEncoding?: string;
    },
  ): string;
}
