export const colors = {
  background: '#F7F8FA',
  surface: '#FFFFFF',
  ink: '#17202A',
  muted: '#667085',
  border: '#E5E7EB',
  primary: '#4F46E5',
  primarySoft: '#EEF2FF',
  success: '#15803D',
  successSoft: '#DCFCE7',
  warning: '#B45309',
  warningSoft: '#FEF3C7',
  danger: '#B42318',
  dangerSoft: '#FEE4E2',
};

export const spacing = { xs: 6, sm: 10, md: 16, lg: 22, xl: 32 } as const;
export const radius = { sm: 10, md: 16, lg: 24 } as const;
export const typography = {
  title: { fontSize: 26, fontWeight: '800' as const, lineHeight: 32 },
  heading: { fontSize: 18, fontWeight: '700' as const, lineHeight: 24 },
  body: { fontSize: 15, lineHeight: 22 },
  caption: { fontSize: 12, lineHeight: 18 },
};
