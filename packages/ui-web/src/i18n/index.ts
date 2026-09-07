import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import zh from "./locales/zh.json"
import en from "./locales/en.json"

i18n.use(initReactI18next).init({
    resources: { zh: { translation: zh }, en: { translation: en } },
    lng: localStorage.getItem("lang") ?? "zh",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
})

i18n.changeLanguage("zh")

export default i18n
