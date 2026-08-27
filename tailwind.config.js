/** @type {import('tailwindcss').Config} */
// The type ramp lives in one place: the --fs-* custom properties in server.js. Tailwind is a
// consumer of that ramp, not a second competing scale. Mapping the utilities here is what
// keeps `text-sm` in markup and `font-size: var(--fs-body)` in CSS the same size forever,
// without a single !important.
//
// Line heights are Tailwind's own defaults, kept deliberately: this mapping is a size
// consolidation and must not reflow 245 existing call sites.
//
// COLOUR works the same way, and for the same reason. Tailwind used to emit these as
// absolute hexes, so the only way to produce a dark theme was a second stylesheet that
// re-stated every utility under [data-theme="dark"] with !important. Routing the utilities
// through --tw-* custom properties moves the theme decision into the token layer, where the
// two values live side by side. The light value below is Tailwind's own, so light rendering
// is unchanged by construction; the dark value is set in the [data-theme="dark"] block.
//
// Only the shades the dark theme actually remaps are var-backed. The rest keep their literal
// value so nothing outside this list changes — and each family is listed in full, because
// `extend` replaces a family wholesale rather than merging into it.
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
      backgroundColor: {
        slate: { 50: 'var(--tw-bg-slate-50)', 100: 'var(--tw-bg-slate-100)', 200: 'var(--tw-bg-slate-200)', 300: 'var(--tw-bg-slate-300)', 400: '#94a3b8', 500: '#64748b', 600: '#475569', 700: '#334155', 800: 'var(--tw-bg-slate-800)', 900: 'var(--tw-bg-slate-900)', 950: '#020617' },
        gray: { 50: '#f9fafb', 100: '#f3f4f6', 200: '#e5e7eb', 300: '#d1d5db', 400: '#9ca3af', 500: 'var(--tw-bg-gray-500)', 600: '#4b5563', 700: 'var(--tw-bg-gray-700)', 800: 'var(--tw-bg-gray-800)', 900: '#111827', 950: '#030712' },
        red: { 50: 'var(--tw-bg-red-50)', 100: 'var(--tw-bg-red-100)', 200: '#fecaca', 300: '#fca5a5', 400: 'var(--tw-bg-red-400)', 500: '#ef4444', 600: 'var(--tw-bg-red-600)', 700: '#b91c1c', 800: '#991b1b', 900: '#7f1d1d', 950: '#450a0a' },
        green: { 50: 'var(--tw-bg-green-50)', 100: 'var(--tw-bg-green-100)', 200: '#bbf7d0', 300: '#86efac', 400: '#4ade80', 500: 'var(--tw-bg-green-500)', 600: 'var(--tw-bg-green-600)', 700: '#15803d', 800: '#166534', 900: '#14532d', 950: '#052e16' },
        blue: { 50: 'var(--tw-bg-blue-50)', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd', 400: '#60a5fa', 500: '#3b82f6', 600: 'var(--tw-bg-blue-600)', 700: 'var(--tw-bg-blue-700)', 800: '#1e40af', 900: '#1e3a8a', 950: '#172554' },
        amber: { 50: 'var(--tw-bg-amber-50)', 100: '#fef3c7', 200: '#fde68a', 300: '#fcd34d', 400: '#fbbf24', 500: '#f59e0b', 600: '#d97706', 700: '#b45309', 800: '#92400e', 900: '#78350f', 950: '#451a03' },
        yellow: { 50: '#fefce8', 100: 'var(--tw-bg-yellow-100)', 200: '#fef08a', 300: '#fde047', 400: '#facc15', 500: '#eab308', 600: '#ca8a04', 700: '#a16207', 800: '#854d0e', 900: '#713f12', 950: '#422006' },
        purple: { 50: '#faf5ff', 100: 'var(--tw-bg-purple-100)', 200: '#e9d5ff', 300: '#d8b4fe', 400: '#c084fc', 500: '#a855f7', 600: '#9333ea', 700: '#7e22ce', 800: '#6b21a8', 900: '#581c87', 950: '#3b0764' },
      },
      textColor: {
        slate: { 50: '#f8fafc', 100: '#f1f5f9', 200: '#e2e8f0', 300: 'var(--tw-text-slate-300)', 400: 'var(--tw-text-slate-400)', 500: 'var(--tw-text-slate-500)', 600: 'var(--tw-text-slate-600)', 700: 'var(--tw-text-slate-700)', 800: 'var(--tw-text-slate-800)', 900: '#0f172a', 950: '#020617' },
        gray: { 50: '#f9fafb', 100: 'var(--tw-text-gray-100)', 200: '#e5e7eb', 300: '#d1d5db', 400: 'var(--tw-text-gray-400)', 500: 'var(--tw-text-gray-500)', 600: 'var(--tw-text-gray-600)', 700: '#374151', 800: '#1f2937', 900: '#111827', 950: '#030712' },
        red: { 50: '#fef2f2', 100: '#fee2e2', 200: '#fecaca', 300: '#fca5a5', 400: 'var(--tw-text-red-400)', 500: 'var(--tw-text-red-500)', 600: 'var(--tw-text-red-600)', 700: 'var(--tw-text-red-700)', 800: 'var(--tw-text-red-800)', 900: '#7f1d1d', 950: '#450a0a' },
        green: { 50: '#f0fdf4', 100: '#dcfce7', 200: '#bbf7d0', 300: '#86efac', 400: '#4ade80', 500: 'var(--tw-text-green-500)', 600: 'var(--tw-text-green-600)', 700: 'var(--tw-text-green-700)', 800: 'var(--tw-text-green-800)', 900: '#14532d', 950: '#052e16' },
        amber: { 50: '#fffbeb', 100: '#fef3c7', 200: '#fde68a', 300: '#fcd34d', 400: '#fbbf24', 500: 'var(--tw-text-amber-500)', 600: '#d97706', 700: '#b45309', 800: 'var(--tw-text-amber-800)', 900: '#78350f', 950: '#451a03' },
        blue: { 50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd', 400: 'var(--tw-text-blue-400)', 500: 'var(--tw-text-blue-500)', 600: 'var(--tw-text-blue-600)', 700: '#1d4ed8', 800: 'var(--tw-text-blue-800)', 900: '#1e3a8a', 950: '#172554' },
        purple: { 50: '#faf5ff', 100: '#f3e8ff', 200: '#e9d5ff', 300: '#d8b4fe', 400: '#c084fc', 500: '#a855f7', 600: '#9333ea', 700: 'var(--tw-text-purple-700)', 800: '#6b21a8', 900: '#581c87', 950: '#3b0764' },
        yellow: { 50: '#fefce8', 100: '#fef9c3', 200: '#fef08a', 300: '#fde047', 400: '#facc15', 500: '#eab308', 600: '#ca8a04', 700: 'var(--tw-text-yellow-700)', 800: '#854d0e', 900: '#713f12', 950: '#422006' },
        emerald: { 50: '#ecfdf5', 100: '#d1fae5', 200: '#a7f3d0', 300: '#6ee7b7', 400: '#34d399', 500: '#10b981', 600: 'var(--tw-text-emerald-600)', 700: '#047857', 800: '#065f46', 900: '#064e3b', 950: '#022c22' },
      },
      borderColor: {
        slate: { 50: 'var(--tw-border-slate-50)', 100: '#f1f5f9', 200: '#e2e8f0', 300: '#cbd5e1', 400: '#94a3b8', 500: '#64748b', 600: '#475569', 700: '#334155', 800: '#1e293b', 900: '#0f172a', 950: '#020617' },
        red: { 50: '#fef2f2', 100: '#fee2e2', 200: '#fecaca', 300: 'var(--tw-border-red-300)', 400: '#f87171', 500: '#ef4444', 600: '#dc2626', 700: '#b91c1c', 800: 'var(--tw-border-red-800)', 900: '#7f1d1d', 950: '#450a0a' },
        green: { 50: '#f0fdf4', 100: '#dcfce7', 200: '#bbf7d0', 300: 'var(--tw-border-green-300)', 400: '#4ade80', 500: '#22c55e', 600: '#16a34a', 700: '#15803d', 800: '#166534', 900: '#14532d', 950: '#052e16' },
        amber: { 50: '#fffbeb', 100: '#fef3c7', 200: '#fde68a', 300: 'var(--tw-border-amber-300)', 400: '#fbbf24', 500: '#f59e0b', 600: '#d97706', 700: '#b45309', 800: '#92400e', 900: '#78350f', 950: '#451a03' },
        blue: { 50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: 'var(--tw-border-blue-300)', 400: '#60a5fa', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8', 800: '#1e40af', 900: '#1e3a8a', 950: '#172554' },
      },
    },
  },
  plugins: [],
};
