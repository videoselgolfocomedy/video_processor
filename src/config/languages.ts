export interface LanguageOption {
  code: string;
  name: string;
  nativeName: string;
}

export const LANGUAGES: LanguageOption[] = [
  { code: 'auto', name: 'Auto-detect', nativeName: 'Auto' },
  { code: 'es', name: 'Spanish', nativeName: 'Espanol' },
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'fr', name: 'French', nativeName: 'Francais' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Portugues' },
  { code: 'de', name: 'German', nativeName: 'Deutsch' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano' },
  { code: 'ca', name: 'Catalan', nativeName: 'Catala' },
  { code: 'eu', name: 'Basque', nativeName: 'Euskara' },
  { code: 'gl', name: 'Galician', nativeName: 'Galego' },
];
