/** @type {import('tailwindcss').Config} */
// The type ramp lives in one place: the --fs-* custom properties in server.js. Tailwind is a
// consumer of that ramp, not a second competing scale. Mapping the utilities here is what
// keeps `text-sm` in markup and `font-size: var(--fs-body)` in CSS the same size forever,
// without a single !important.
//
// Line heights are Tailwind's own defaults, kept deliberately: this mapping is a size
// consolidation and must not reflow 245 existing call sites.
module.exports = {
  content: ['./server.js'],
  theme: {
    extend: {
      fontSize: {
        '2xs':  ['var(--fs-label)',   { lineHeight: '1rem' }],     // 11px — the floor
        'xs':   ['var(--fs-sm)',      { lineHeight: '1rem' }],     // 12px
        'sm':   ['var(--fs-body)',    { lineHeight: '1.25rem' }],  // 14px
        'base': ['var(--fs-body-lg)', { lineHeight: '1.5rem' }],   // 16px
        'lg':   ['var(--fs-title)',   { lineHeight: '1.75rem' }],  // 18px
        'xl':   ['var(--fs-title)',   { lineHeight: '1.75rem' }],  // 18px (was 20, off-ramp)
        '2xl':  ['var(--fs-display)', { lineHeight: '2rem' }],     // 24px
        '3xl':  ['var(--fs-vital)',   { lineHeight: '2.25rem' }],  // 30px
        '4xl':  ['var(--fs-vital)',   { lineHeight: '2.5rem' }],   // 30px (was 36, off-ramp)
      },
      borderRadius: {
        sm: 'var(--r-sm)', DEFAULT: 'var(--r-md)', md: 'var(--r-md)',
        lg: 'var(--r-lg)', xl: 'var(--r-lg)', '2xl': 'var(--r-xl)', '3xl': 'var(--r-xl)',
      },
    },
  },
  plugins: [],
};
