/**
 * English dictionary. This file defines the dictionary shape; every other
 * locale must satisfy `Dictionary`, so missing keys fail typecheck.
 */
const en = {
  meta: {
    title: "Fashion Commerce",
    description: "Considered clothing and accessories for women and children.",
  },
  brand: {
    name: "Fashion Commerce",
    tagline: "Considered wardrobe",
  },
  nav: {
    label: "Primary",
    women: "Women",
    children: "Children",
    accessories: "Accessories",
    underwear: "Underwear",
    languageSwitch: "Language",
  },
  home: {
    eyebrow: "Autumn — Winter",
    title: "Quiet pieces, made to be lived in.",
    lead: "A wardrobe built on texture, proportion and restraint — in store and online, with one inventory behind both.",
    primaryCta: "Explore the collection",
    secondaryCta: "Visit a boutique",
    categoriesTitle: "The house",
    comingSoon: "Opening soon",
    categories: {
      women: "Tailoring, knitwear and evening pieces.",
      children: "Soft, durable clothing for growing years.",
      accessories: "Leather goods, scarves and finishing details.",
      underwear: "Essentials in natural fibres.",
    },
    servicesTitle: "Services",
    services: {
      stylist: {
        title: "Personal styling",
        body: "Guidance from our stylists, with AI-assisted suggestions to follow.",
      },
      boutique: {
        title: "Boutique & online",
        body: "Reserve online, try in store, return anywhere.",
      },
      care: {
        title: "Care & alterations",
        body: "Tailoring and aftercare for every piece we sell.",
      },
    },
  },
  footer: {
    rights: "All rights reserved.",
    note: "Platform foundation — catalogue not yet live.",
  },
  errors: {
    notFoundCode: "404",
    notFoundTitle: "This page could not be found.",
    notFoundBody: "The piece you are looking for may have moved or is no longer available.",
    backHome: "Return to the homepage",
    errorTitle: "Something went wrong.",
    errorBody: "We could not load this page. Please try again in a moment.",
    retry: "Try again",
    reference: "Reference",
  },
};

type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };
export type Dictionary = Widen<typeof en>;

export default en;
