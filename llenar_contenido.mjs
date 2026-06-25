/**
 * Rellena los campos editables (descripcion, beneficios, ingredientes, dosis,
 * modoUso, advertencias, presentacion) de productos.json a partir del nombre
 * de cada producto. NO toca precio (no hay dato).
 *
 * Contenido informativo generado automáticamente: VERIFICAR contra la etiqueta
 * real antes de publicar, sobre todo dosis y advertencias.
 *
 * Uso:  node llenar_contenido.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";

// --- Advertencias estándar por tipo ---
const ADV_SUPP =
  "Suplemento dietario. No reemplaza una alimentación variada y equilibrada. " +
  "Consulta a tu médico antes de usar si estás embarazada, en lactancia, tomas " +
  "medicamentos o tienes alguna condición médica. No excedas la dosis sugerida. " +
  "Mantener fuera del alcance de los niños.";
const ADV_MED =
  "Medicamento de venta libre. Lee la etiqueta y sigue las indicaciones. No " +
  "excedas la dosis. Consulta a un profesional de la salud si los síntomas " +
  "persisten. Mantener fuera del alcance de los niños.";
const ADV_TOPICAL =
  "Solo para uso externo. Evita el contacto con los ojos. Haz una prueba en una " +
  "zona pequeña antes del primer uso y suspende si aparece irritación. Mantener " +
  "fuera del alcance de los niños.";
const ADV_BABY =
  "Solo para uso externo. Evita el contacto con los ojos. Suspende si aparece " +
  "irritación y consulta al pediatra. Mantener fuera del alcance de los niños.";
const ADV_PET =
  "Exclusivo para uso en mascotas. Proporciona agua fresca. Consulta a tu " +
  "veterinario ante cualquier duda o condición de salud de tu mascota.";
const ADV_FRAG =
  "Solo para uso externo. Producto inflamable: mantener lejos del fuego. Evita " +
  "el contacto con los ojos. Suspende si aparece irritación.";
const ADV_FOOD =
  "Consúmase como parte de una dieta equilibrada. Contiene cafeína: no " +
  "recomendado para menores, embarazadas ni personas sensibles a la cafeína.";

// --- Contenido por SKU ---
const C = {
  "SalCar-301": {
    presentacion: "180 cápsulas · 1000 mg",
    descripcion: "Cúrcuma (curcumina) con pimienta negra para mejorar su absorción. Apoya la respuesta antiinflamatoria y antioxidante natural del cuerpo.",
    beneficios: ["Apoyo antiinflamatorio natural", "Acción antioxidante", "Pimienta negra para mejor absorción", "Apoya la salud articular"],
    ingredientes: ["Cúrcuma (Curcuma longa) 1000 mg", "Extracto de pimienta negra (piperina)"],
    dosis: "1 cápsula al día, preferiblemente con una comida.",
    advertencias: ADV_SUPP,
  },
  "Salpip-412": {
    presentacion: "100 cápsulas · 2000 mg",
    descripcion: "Fenogreco en alta concentración, usado tradicionalmente como apoyo digestivo y para el bienestar metabólico.",
    beneficios: ["Apoyo digestivo", "Bienestar metabólico", "Uso tradicional en lactancia", "Fuente vegetal natural"],
    ingredientes: ["Semilla de fenogreco (Trigonella foenum-graecum) 2000 mg"],
    dosis: "2 cápsulas al día con agua y alimentos.",
    advertencias: ADV_SUPP,
  },
  "Salpip-410": {
    presentacion: "100 cápsulas · 750 mg",
    descripcion: "GABA (ácido gamma-aminobutírico), aminoácido que el cuerpo usa para favorecer la relajación y la calma.",
    beneficios: ["Favorece la relajación", "Apoya la calma mental", "Ayuda a sobrellevar el estrés", "Apto antes del descanso"],
    ingredientes: ["GABA (ácido gamma-aminobutírico) 750 mg"],
    dosis: "1 cápsula al día, según necesidad.",
    advertencias: ADV_SUPP,
  },
  "Salnow-442": {
    presentacion: "100 cápsulas · 500 mg",
    descripcion: "GABA de NOW Foods, un aminoácido asociado a la relajación y al manejo del estrés cotidiano.",
    beneficios: ["Favorece la relajación", "Apoyo frente al estrés", "Sensación de calma", "Marca reconocida"],
    ingredientes: ["GABA (ácido gamma-aminobutírico) 500 mg"],
    dosis: "1 cápsula al día.",
    advertencias: ADV_SUPP,
  },
  "Salnow-405": {
    presentacion: "100 cápsulas · 500 mg",
    descripcion: "Inositol de NOW Foods, asociado al equilibrio del estado de ánimo y al metabolismo.",
    beneficios: ["Apoya el equilibrio del ánimo", "Bienestar metabólico", "Apoyo al sistema nervioso"],
    ingredientes: ["Inositol 500 mg"],
    dosis: "1 cápsula al día con comida.",
    advertencias: ADV_SUPP,
  },
  "SalWho-001": {
    presentacion: "120 cápsulas",
    descripcion: "Combinación de Myo-inositol y D-Chiro inositol en proporción equilibrada, popular como apoyo hormonal y metabólico femenino.",
    beneficios: ["Apoyo hormonal femenino", "Bienestar metabólico", "Proporción equilibrada Myo/D-Chiro"],
    ingredientes: ["Myo-inositol", "D-Chiro inositol"],
    dosis: "Tomar según indicación de la etiqueta, usualmente repartido en el día.",
    advertencias: ADV_SUPP,
  },
  "SalVit-208": {
    presentacion: "90 gomitas",
    descripcion: "Multivitamínico prenatal en gomitas Vitafusion, con nutrientes clave para acompañar el embarazo.",
    beneficios: ["Apoyo nutricional prenatal", "Con ácido fólico y DHA", "Fácil de tomar (gomitas)"],
    ingredientes: ["Ácido fólico", "DHA", "Vitaminas A, C, D, E", "Yodo"],
    dosis: "2 gomitas al día.",
    advertencias: ADV_SUPP,
  },
  "SalSpr-389": {
    presentacion: "120 cápsulas · 2000 mg",
    descripcion: "Vitamina C en alta dosis de Spring Valley, antioxidante que apoya las defensas.",
    beneficios: ["Apoya el sistema inmune", "Acción antioxidante", "Contribuye a la producción de colágeno"],
    ingredientes: ["Vitamina C (ácido ascórbico) 2000 mg"],
    dosis: "1 cápsula al día con comida.",
    advertencias: ADV_SUPP,
  },
  "SalSpr-199": {
    presentacion: "100 tabletas · 1000 mg",
    descripcion: "L-Lisina, aminoácido esencial usado como apoyo inmune y para la salud de la piel.",
    beneficios: ["Apoyo al sistema inmune", "Salud de la piel", "Aminoácido esencial"],
    ingredientes: ["L-Lisina 1000 mg"],
    dosis: "1 tableta al día.",
    advertencias: ADV_SUPP,
  },
  "SalPip-323": {
    presentacion: "59 mL · gotero",
    descripcion: "Aceite de orégano ecológico en gotas, tradicionalmente usado por sus propiedades de apoyo inmune.",
    beneficios: ["Apoyo inmune natural", "Origen ecológico", "Presentación líquida en gotas"],
    ingredientes: ["Aceite de orégano (Origanum vulgare)", "Aceite portador"],
    dosis: "Diluir unas gotas en agua o aceite, según etiqueta.",
    advertencias: ADV_SUPP,
  },
  "SalPip-268": {
    presentacion: "60 tabletas",
    descripcion: "Fórmula nutricional DHT de Piping Rock, orientada al bienestar capilar y hormonal.",
    beneficios: ["Apoyo al bienestar capilar", "Fórmula combinada", "Apoyo hormonal (uso tradicional)"],
    ingredientes: ["Mezcla de hierbas y nutrientes (ver etiqueta)"],
    dosis: "Tomar según indicación de la etiqueta.",
    advertencias: ADV_SUPP,
  },
  "SalNow-329": {
    presentacion: "120 cápsulas · 5000 UI",
    descripcion: "Vitamina D3 de alta potencia de NOW Foods, clave para los huesos y el sistema inmune.",
    beneficios: ["Salud ósea", "Apoyo inmune", "Alta potencia (5000 UI)"],
    ingredientes: ["Vitamina D3 (colecalciferol) 5000 UI"],
    dosis: "1 cápsula al día con una comida que contenga grasa.",
    advertencias: ADV_SUPP,
  },
  "SalNow-123": {
    presentacion: "120 cápsulas",
    descripcion: "Vitamina D3 + K2 (MK-7) de NOW Foods; la K2 ayuda a dirigir el calcio hacia los huesos.",
    beneficios: ["Salud ósea", "Apoyo cardiovascular", "Sinergia D3 + K2"],
    ingredientes: ["Vitamina D3 1000 UI", "Vitamina K2 (MK-7) 45 mcg"],
    dosis: "1 cápsula al día con comida.",
    advertencias: ADV_SUPP,
  },
  "SalNew-302": {
    presentacion: "60 cápsulas · 50 mil millones UFC",
    descripcion: "Probiótico avanzado de 20 cepas y 50 mil millones de UFC para la defensa digestiva.",
    beneficios: ["Salud digestiva", "Equilibrio de la flora intestinal", "20 cepas · 50 mil millones UFC"],
    ingredientes: ["Mezcla probiótica de 20 cepas (50 mil millones UFC)", "Prebióticos"],
    dosis: "1 cápsula al día, preferiblemente en ayunas.",
    advertencias: ADV_SUPP,
  },
  "SalNeo-321": {
    presentacion: "567 g · polvo",
    descripcion: "Bio-péptidos de colágeno en polvo NeoCell para la piel, el cabello, las uñas y las articulaciones.",
    beneficios: ["Firmeza de la piel", "Cabello y uñas", "Apoyo articular", "Fácil de mezclar"],
    ingredientes: ["Péptidos de colágeno hidrolizado"],
    dosis: "Mezclar una porción (según etiqueta) en agua o bebida, 1 vez al día.",
    advertencias: ADV_SUPP,
  },
  "SalNat-441": {
    presentacion: "120 cápsulas blandas · 10 000 mcg",
    descripcion: "Biotina en alta dosis de Nature's Bounty para el cabello, la piel y las uñas.",
    beneficios: ["Cabello más fuerte", "Uñas saludables", "Piel radiante", "Alta dosis (10 000 mcg)"],
    ingredientes: ["Biotina (vitamina B7) 10 000 mcg"],
    dosis: "1 cápsula blanda al día.",
    advertencias: ADV_SUPP,
  },
  "SalNat-436": {
    presentacion: "8 oz · polvo · sabor fresa-limón",
    descripcion: "Citrato de magnesio en polvo (MagicMag) de NaturalSlim, de fácil absorción y sabor agradable.",
    beneficios: ["Relajación muscular", "Apoyo al descanso", "Fácil absorción", "Sabor fresa-limón"],
    ingredientes: ["Citrato de magnesio"],
    dosis: "Disolver una porción en agua tibia, según etiqueta, preferiblemente por la noche.",
    advertencias: ADV_SUPP,
  },
  "SalNat-207": {
    presentacion: "120 cápsulas · 1200 mg",
    descripcion: "Calcio con vitamina D3 de Nature's Bounty para fortalecer huesos y dientes.",
    beneficios: ["Salud ósea", "Dientes fuertes", "Con vitamina D3 para mejor absorción"],
    ingredientes: ["Calcio 1200 mg", "Vitamina D3"],
    dosis: "1 cápsula al día con comida.",
    advertencias: ADV_SUPP,
  },
  "SalNOW-333": {
    presentacion: "90 cápsulas",
    descripcion: "Candida Support de NOW Foods, mezcla herbal que apoya el equilibrio de la flora intestinal.",
    beneficios: ["Equilibrio de la flora", "Apoyo digestivo", "Mezcla herbal"],
    ingredientes: ["Ácido caprílico", "Extractos herbales (ver etiqueta)"],
    dosis: "Tomar según indicación de la etiqueta, con comidas.",
    advertencias: ADV_SUPP,
  },
  "SalLac-001": {
    presentacion: "120 cápsulas",
    descripcion: "Lactaid Fast Act aporta la enzima lactasa para ayudar a digerir la lactosa.",
    beneficios: ["Ayuda a digerir lácteos", "Acción rápida", "Reduce molestias por lactosa"],
    ingredientes: ["Enzima lactasa"],
    dosis: "Tomar al inicio de una comida con lácteos, según etiqueta.",
    advertencias: ADV_SUPP,
  },
  "SalEqu-385": {
    presentacion: "250 cápsulas · 500 mg",
    descripcion: "Acetaminofén (paracetamol) de Equate para el alivio temporal del dolor leve a moderado y la fiebre.",
    beneficios: ["Alivia el dolor leve a moderado", "Reduce la fiebre", "Presentación de alto conteo"],
    ingredientes: ["Acetaminofén 500 mg"],
    dosis: "Según etiqueta. No excedas la dosis máxima diaria indicada.",
    advertencias: ADV_MED + " No combinar con otros productos que contengan acetaminofén ni con alcohol.",
  },
  "SalKir-84": {
    presentacion: "96 tabletas (pack 2) · 25 mg",
    descripcion: "Ayuda para dormir de Kirkland a base de difenhidramina, para el alivio ocasional del insomnio.",
    beneficios: ["Favorece la conciliación del sueño", "Para uso ocasional", "Pack de 2"],
    ingredientes: ["Difenhidramina HCl 25 mg"],
    dosis: "Tomar antes de acostarse, según etiqueta.",
    advertencias: ADV_MED + " No usar con alcohol. Puede causar somnolencia: no conducir tras tomarlo.",
  },
  "SalKir-367": {
    presentacion: "600 cápsulas · 2000 UI",
    descripcion: "Vitamina D3 extra fuerte de Kirkland Signature, presentación de alto conteo para huesos e inmunidad.",
    beneficios: ["Salud ósea", "Apoyo inmune", "Rinde mucho tiempo (600 cáp)"],
    ingredientes: ["Vitamina D3 (colecalciferol) 50 mcg / 2000 UI"],
    dosis: "1 cápsula al día con comida.",
    advertencias: ADV_SUPP,
  },
  "SalKir-366": {
    presentacion: "100 cápsulas · 300 mg",
    descripcion: "Coenzima Q10 (CoQ10) de Kirkland Signature, antioxidante que apoya la energía celular y la salud cardiovascular.",
    beneficios: ["Energía celular", "Apoyo cardiovascular", "Acción antioxidante", "Alta potencia (300 mg)"],
    ingredientes: ["Coenzima Q10 300 mg"],
    dosis: "1 cápsula al día con una comida con grasa.",
    advertencias: ADV_SUPP,
  },
  "SalNOW-319": {
    presentacion: "180 cápsulas blandas",
    descripcion: "Ultra Omega-3 de NOW Foods (500 EPA / 250 DHA), aceite de pescado purificado para el corazón y el cerebro.",
    beneficios: ["Salud cardiovascular", "Apoyo cognitivo", "Alta concentración EPA/DHA", "Purificado"],
    ingredientes: ["Aceite de pescado", "EPA 500 mg", "DHA 250 mg"],
    dosis: "1 cápsula blanda al día con comida.",
    advertencias: ADV_SUPP,
  },
  "SalKir-125": {
    presentacion: "250 tabletas",
    descripcion: "Controlador de ácido de Kirkland (famotidina) para prevenir y aliviar la acidez estomacal.",
    beneficios: ["Alivia la acidez", "Previene la indigestión", "Alto conteo"],
    ingredientes: ["Famotidina"],
    dosis: "Según etiqueta, antes de comidas que causen acidez.",
    advertencias: ADV_MED,
  },
  "SalHor-405": {
    presentacion: "180 cápsulas · 100 mg",
    descripcion: "Picolinato de zinc de Horbäach, mineral esencial para la inmunidad y la piel.",
    beneficios: ["Apoyo inmune", "Salud de la piel", "Forma de fácil absorción (picolinato)"],
    ingredientes: ["Zinc (como picolinato de zinc)"],
    dosis: "1 cápsula al día con comida.",
    advertencias: ADV_SUPP,
  },
  "SalHor-396": {
    presentacion: "120 cápsulas · 750 mg",
    descripcion: "Bisglicinato de magnesio de Horbäach, forma quelada suave con el estómago y de buena absorción.",
    beneficios: ["Relajación muscular", "Apoyo al descanso", "Suave con el estómago", "Buena absorción"],
    ingredientes: ["Magnesio (como bisglicinato) 750 mg"],
    dosis: "Tomar según etiqueta, preferiblemente por la noche.",
    advertencias: ADV_SUPP,
  },
  "SalHor-337": {
    presentacion: "120 cápsulas · fuerza máxima",
    descripcion: "Ashwagandha de Horbäach en fuerza máxima, adaptógeno tradicional para el manejo del estrés.",
    beneficios: ["Ayuda frente al estrés", "Favorece la calma", "Apoya la energía y el ánimo", "Adaptógeno"],
    ingredientes: ["Ashwagandha (Withania somnifera)", "Raíz de jengibre", "Pimienta negra"],
    dosis: "Tomar según indicación de la etiqueta.",
    advertencias: ADV_SUPP,
  },
  "Salhor-403": {
    presentacion: "60 cápsulas · 10 mg",
    descripcion: "Astaxantina de Horbäach, potente antioxidante de origen marino para la piel y los ojos.",
    beneficios: ["Antioxidante potente", "Salud de la piel", "Apoyo a la vista", "Recuperación"],
    ingredientes: ["Astaxantina 10 mg"],
    dosis: "1 cápsula al día con comida.",
    advertencias: ADV_SUPP,
  },
  "SalHor-332": {
    presentacion: "120 cápsulas · 400 mg",
    descripcion: "L-teanina de Horbäach, aminoácido del té verde que favorece la calma sin somnolencia.",
    beneficios: ["Favorece la calma", "Concentración relajada", "Sin OMG ni gluten"],
    ingredientes: ["L-teanina 400 mg"],
    dosis: "1 cápsula al día.",
    advertencias: ADV_SUPP,
  },
  "SalHor-298": {
    presentacion: "120 comprimidos",
    descripcion: "Fórmula capilar tipo DHT de Horbäach, mezcla de nutrientes para el bienestar del cabello.",
    beneficios: ["Apoyo al cabello", "Fórmula combinada", "Sin OMG ni gluten"],
    ingredientes: ["Mezcla de hierbas y nutrientes (ver etiqueta)"],
    dosis: "Tomar según indicación de la etiqueta.",
    advertencias: ADV_SUPP,
  },
  "SalHor-330": {
    presentacion: "180 cápsulas · 5000 UI",
    descripcion: "Vitamina D3 + K2 (MK-7) de Horbäach; combinación que apoya huesos y sistema cardiovascular.",
    beneficios: ["Salud ósea", "Apoyo cardiovascular", "Sinergia D3 + K2", "Alta dosis"],
    ingredientes: ["Vitamina D3 5000 UI", "Vitamina K2 (MK-7) 100 mcg"],
    dosis: "1 cápsula al día con comida.",
    advertencias: ADV_SUPP,
  },
  "SalHor-328": {
    presentacion: "250 cápsulas · 1800 mg",
    descripcion: "Malato de magnesio de Horbäach, forma asociada a la energía y al confort muscular.",
    beneficios: ["Energía muscular", "Confort muscular", "Apoyo metabólico"],
    ingredientes: ["Malato de magnesio 1800 mg"],
    dosis: "Tomar según etiqueta, con comidas.",
    advertencias: ADV_SUPP,
  },
  "SalHor-300": {
    presentacion: "120 cápsulas · 30 000 mg",
    descripcion: "Extracto concentrado de arándano con vitamina C de Horbäach, apoyo para las vías urinarias.",
    beneficios: ["Salud de vías urinarias", "Con vitamina C", "Antioxidante", "Extracto concentrado"],
    ingredientes: ["Extracto de arándano rojo (cranberry)", "Vitamina C"],
    dosis: "1 cápsula al día con agua.",
    advertencias: ADV_SUPP,
  },
  "SalHor-294": {
    presentacion: "120 tabletas sublinguales · 5000 mcg",
    descripcion: "Vitamina B12 (metilcobalamina) sublingual de Horbäach, para la energía y el sistema nervioso.",
    beneficios: ["Apoyo energético", "Sistema nervioso", "Absorción sublingual", "Forma activa (metilcobalamina)"],
    ingredientes: ["Vitamina B12 (metilcobalamina) 5000 mcg"],
    dosis: "Disolver 1 tableta bajo la lengua al día.",
    advertencias: ADV_SUPP,
  },
  "SalHor-200": {
    presentacion: "250 cápsulas · 1330 mg",
    descripcion: "Glicinato de magnesio buffered de Horbäach, suave con el estómago y de buena tolerancia.",
    beneficios: ["Relajación muscular", "Apoyo al descanso", "Suave con el estómago", "Alto conteo"],
    ingredientes: ["Magnesio (como glicinato buffered) 1330 mg"],
    dosis: "Tomar según etiqueta, preferiblemente por la noche.",
    advertencias: ADV_SUPP,
  },
  "SalDoc-398": {
    presentacion: "150 cápsulas",
    descripcion: "Complejo de colágeno de Doctor's Way con vitamina C y biotina, para piel, cabello y articulaciones.",
    beneficios: ["Firmeza de la piel", "Cabello y uñas", "Apoyo articular", "Con vitamina C y biotina"],
    ingredientes: ["Colágeno hidrolizado", "Vitamina C", "Biotina"],
    dosis: "Tomar según indicación de la etiqueta.",
    advertencias: ADV_SUPP,
  },
  "SalDoc-397": {
    presentacion: "200 cápsulas",
    descripcion: "Glucosamina, condroitina y cúrcuma de Doctor's Way para la salud articular y la movilidad.",
    beneficios: ["Salud articular", "Movilidad y flexibilidad", "Con cúrcuma antiinflamatoria"],
    ingredientes: ["Glucosamina", "Condroitina", "Cúrcuma"],
    dosis: "Tomar según indicación de la etiqueta, con comidas.",
    advertencias: ADV_SUPP,
  },
  "SalDea-195": {
    presentacion: "240 cápsulas · 1000 mg",
    descripcion: "Glicinato de magnesio de Deal Supplement, forma quelada de buena absorción y tolerancia.",
    beneficios: ["Relajación muscular", "Apoyo al descanso", "Buena absorción", "Alto conteo"],
    ingredientes: ["Magnesio (como glicinato) 1000 mg"],
    dosis: "Tomar según etiqueta, preferiblemente por la noche.",
    advertencias: ADV_SUPP,
  },
  "SalCom-188": {
    presentacion: "180 cápsulas · 1800 mg",
    descripcion: "Complejo de resveratrol de Piping Rock, antioxidante asociado a la salud cardiovascular y al antienvejecimiento.",
    beneficios: ["Antioxidante", "Apoyo cardiovascular", "Bienestar celular"],
    ingredientes: ["Resveratrol", "Complejo de extractos antioxidantes"],
    dosis: "Tomar según indicación de la etiqueta.",
    advertencias: ADV_SUPP,
  },
  "SalCen-371": {
    presentacion: "100 gomitas · sabor tropical",
    descripcion: "Multivitamínico Centrum para mujeres en gomitas, con nutrientes esenciales del día a día.",
    beneficios: ["Apoyo nutricional diario", "Energía y bienestar", "Fácil de tomar (gomitas)"],
    ingredientes: ["Vitaminas A, C, D, E", "Vitaminas del complejo B", "Minerales"],
    dosis: "2 gomitas al día.",
    advertencias: ADV_SUPP,
  },
  "SalCen-370": {
    presentacion: "100 gomitas",
    descripcion: "Centrum Multi+Beauty para mujer en gomitas, con nutrientes orientados a piel, cabello y uñas.",
    beneficios: ["Belleza desde adentro", "Con biotina", "Apoyo nutricional", "Fácil de tomar"],
    ingredientes: ["Biotina", "Vitaminas y minerales (ver etiqueta)"],
    dosis: "2 gomitas al día.",
    advertencias: ADV_SUPP,
  },
  "SalCen-369": {
    presentacion: "170 gomitas",
    descripcion: "Multivitamínico Centrum para mujer en gomitas, presentación de alto conteo.",
    beneficios: ["Apoyo nutricional diario", "Energía y bienestar", "Alto conteo (170)"],
    ingredientes: ["Vitaminas A, C, D, E", "Complejo B", "Minerales"],
    dosis: "2 gomitas al día.",
    advertencias: ADV_SUPP,
  },
  "SalCar-365": {
    presentacion: "120 cápsulas blandas · 12 mg",
    descripcion: "Astaxantina con aceite de coco de Carlyle, antioxidante de origen marino de mayor absorción.",
    beneficios: ["Antioxidante potente", "Salud de la piel y la vista", "Con aceite de coco para absorción"],
    ingredientes: ["Astaxantina 12 mg", "Aceite de coco"],
    dosis: "1 cápsula blanda al día con comida.",
    advertencias: ADV_SUPP,
  },
  "SalCar-363": {
    presentacion: "180 cápsulas · 3000 mg",
    descripcion: "Curcumina de cúrcuma en alta dosis de Carlyle, apoyo antiinflamatorio y antioxidante.",
    beneficios: ["Apoyo antiinflamatorio", "Acción antioxidante", "Salud articular", "Alta dosis (3000 mg)"],
    ingredientes: ["Cúrcuma (Curcuma longa) 3000 mg", "Pimienta negra"],
    dosis: "Tomar según etiqueta, con comida.",
    advertencias: ADV_SUPP,
  },
  "SalCar-362": {
    presentacion: "60 cápsulas · 500 mg",
    descripcion: "Berberina HCL de Carlyle, compuesto vegetal asociado al control del azúcar y la salud metabólica.",
    beneficios: ["Apoyo metabólico", "Equilibrio del azúcar en sangre", "Salud cardiovascular"],
    ingredientes: ["Berberina HCL 500 mg"],
    dosis: "1 cápsula con las comidas principales, según etiqueta.",
    advertencias: ADV_SUPP,
  },
  "SalKir-282": {
    presentacion: "365 comprimidos (pack 2) · 81 mg",
    descripcion: "Aspirina de dosis baja (81 mg) de Kirkland, con recubrimiento entérico para uso prolongado.",
    beneficios: ["Dosis baja (81 mg)", "Recubrimiento entérico", "Pack de 2 · alto conteo"],
    ingredientes: ["Ácido acetilsalicílico 81 mg"],
    dosis: "Según indicación médica y la etiqueta.",
    advertencias: ADV_MED + " El uso prolongado de aspirina debe ser indicado por tu médico.",
  },
  "SalCar-335": {
    presentacion: "60 unidades · 4200 mg",
    descripcion: "Melena de león (Hericium erinaceus) de Carlyle, hongo funcional asociado al enfoque y la salud cognitiva.",
    beneficios: ["Apoyo cognitivo", "Enfoque y memoria", "Hongo funcional", "Alta potencia"],
    ingredientes: ["Melena de león (Hericium erinaceus) 4200 mg"],
    dosis: "Tomar según indicación de la etiqueta.",
    advertencias: ADV_SUPP,
  },
  "SalCar-361": {
    presentacion: "250 mini tabletas",
    descripcion: "Glucosamina, condroitina y MSM de Carlyle en mini tabletas, trío clásico para las articulaciones.",
    beneficios: ["Salud articular", "Movilidad", "Con MSM", "Mini tabletas fáciles de tragar"],
    ingredientes: ["Glucosamina", "Condroitina", "MSM"],
    dosis: "Tomar según indicación de la etiqueta, con comidas.",
    advertencias: ADV_SUPP,
  },
  "SalCar-360": {
    presentacion: "70 cápsulas",
    descripcion: "Ashwagandha (KSM-66) con melatonina de Carlyle, combinación para la calma y el descanso nocturno.",
    beneficios: ["Favorece el descanso", "Ayuda frente al estrés", "Con melatonina 5 mg", "KSM-66 estandarizado"],
    ingredientes: ["Ashwagandha KSM-66 600 mg", "Melatonina 5 mg"],
    dosis: "1 cápsula antes de dormir.",
    advertencias: ADV_SUPP,
  },
  "SalKir-283": {
    presentacion: "500 comprimidos · 500 mg",
    descripcion: "Acetaminofén extrafuerte (500 mg) de Kirkland para el alivio del dolor y la fiebre, alto conteo.",
    beneficios: ["Alivia el dolor", "Reduce la fiebre", "Extrafuerte (500 mg)", "Alto conteo"],
    ingredientes: ["Acetaminofén 500 mg"],
    dosis: "Según etiqueta. No excedas la dosis máxima diaria.",
    advertencias: ADV_MED + " No combinar con otros productos con acetaminofén ni con alcohol.",
  },
  "SalCar-334": {
    presentacion: "90 cápsulas · 600 mg",
    descripcion: "Ácido alfa lipoico con biotina de Carlyle, antioxidante con apoyo metabólico y nervioso.",
    beneficios: ["Antioxidante", "Apoyo metabólico", "Salud nerviosa", "Con biotina"],
    ingredientes: ["Ácido alfa lipoico 600 mg", "Biotina"],
    dosis: "1 cápsula al día con comida.",
    advertencias: ADV_SUPP,
  },
  "SalCar-327": {
    presentacion: "120 cápsulas · 2740 mg",
    descripcion: "Glicinato de magnesio con ashwagandha de Carlyle, combinación para la relajación y el manejo del estrés.",
    beneficios: ["Relajación", "Apoyo frente al estrés", "Descanso reparador", "Combinación sinérgica"],
    ingredientes: ["Glicinato de magnesio", "Ashwagandha"],
    dosis: "Tomar según etiqueta, preferiblemente por la noche.",
    advertencias: ADV_SUPP,
  },
  "SalCar-299": {
    presentacion: "150 cápsulas · 4000 mg",
    descripcion: "Aceite de orégano en alta concentración de Carlyle, tradicionalmente usado como apoyo inmune.",
    beneficios: ["Apoyo inmune natural", "Alta concentración (4000 mg)", "Antioxidante"],
    ingredientes: ["Aceite de orégano (Origanum vulgare)"],
    dosis: "1 cápsula al día con comida.",
    advertencias: ADV_SUPP,
  },
  "SalBen-265": {
    presentacion: "2 tubos · 113 g c/u",
    descripcion: "Crema Bengay para el alivio temporal de dolores musculares y articulares por su efecto calor/frío.",
    beneficios: ["Alivia dolores musculares", "Confort articular", "Efecto analgésico tópico", "Pack de 2"],
    ingredientes: ["Mentol", "Salicilato de metilo"],
    modoUso: "Aplica una capa fina sobre la zona adolorida hasta 3-4 veces al día. Lava tus manos después.",
    advertencias: ADV_TOPICAL + " No aplicar sobre heridas ni usar con vendajes apretados o calor.",
  },
  "BelPip-297": {
    presentacion: "200 cápsulas · 4000 mg",
    descripcion: "Aceite de orégano en alta concentración de Piping Rock, apoyo inmune de uso tradicional.",
    beneficios: ["Apoyo inmune natural", "Alta concentración (4000 mg)", "Alto conteo (200 cáp)"],
    ingredientes: ["Aceite de orégano (Origanum vulgare)"],
    dosis: "1 cápsula al día con comida.",
    advertencias: ADV_SUPP,
  },
  "SalNat-439": {
    presentacion: "453 g · polvo · sabor naranja",
    descripcion: "Citrato de magnesio en polvo (Calming) sabor naranja, bebida relajante para el final del día.",
    beneficios: ["Relajación", "Apoyo al descanso", "Sabor naranja", "Fácil de mezclar"],
    ingredientes: ["Citrato de magnesio"],
    dosis: "Disolver una porción en agua tibia por la noche, según etiqueta.",
    advertencias: ADV_SUPP,
  },
  "Belnat-408": {
    presentacion: "150 cápsulas blandas · 5000 mcg",
    descripcion: "Fórmula Hair, Skin & Nails con biotina de alta dosis para la belleza desde adentro.",
    beneficios: ["Cabello fuerte", "Piel saludable", "Uñas resistentes", "Con biotina 5000 mcg"],
    ingredientes: ["Biotina 5000 mcg", "Vitaminas y antioxidantes (ver etiqueta)"],
    dosis: "1 cápsula blanda al día con comida.",
    advertencias: ADV_SUPP,
  },
  "Salpip-411": {
    presentacion: "120 comprimidos sublinguales · 1000 mcg",
    descripcion: "Vitamina B12 (metilcobalamina) sublingual de Piping Rock, para la energía y el sistema nervioso.",
    beneficios: ["Apoyo energético", "Sistema nervioso", "Absorción sublingual", "Forma activa"],
    ingredientes: ["Vitamina B12 (metilcobalamina) 1000 mcg"],
    dosis: "Disolver 1 comprimido bajo la lengua al día.",
    advertencias: ADV_SUPP,
  },
  "SalHor-404": {
    presentacion: "120 cápsulas",
    descripcion: "Raíz de maca de Horbäach para hombres y mujeres, asociada a la energía, la vitalidad y el equilibrio hormonal.",
    beneficios: ["Energía y vitalidad", "Apoyo hormonal", "Para hombres y mujeres", "Raíz tradicional andina"],
    ingredientes: ["Raíz de maca (Lepidium meyenii)"],
    dosis: "Tomar según indicación de la etiqueta.",
    advertencias: ADV_SUPP,
  },
  "AliCel-281": {
    presentacion: "Pack de 14 latas · sabor limón",
    descripcion: "Bebida energizante Celsius sabor limón, sin azúcar, con vitaminas y extractos que apoyan el metabolismo.",
    beneficios: ["Energía sin azúcar", "Acelera el metabolismo", "Con vitaminas", "Pack de 14"],
    ingredientes: ["Cafeína", "Té verde", "Vitaminas del complejo B", "Vitamina C"],
    modoUso: "Consumir frío. Ideal antes de la actividad física.",
    advertencias: ADV_FOOD,
  },
  "Salpip-416": {
    presentacion: "90 comprimidos sublinguales · 10 000 mcg",
    descripcion: "Biotina sublingual en alta dosis de Piping Rock para cabello, piel y uñas, de rápida absorción.",
    beneficios: ["Cabello y uñas fuertes", "Piel saludable", "Absorción sublingual", "Alta dosis (10 000 mcg)"],
    ingredientes: ["Biotina (vitamina B7) 10 000 mcg"],
    dosis: "Disolver 1 comprimido bajo la lengua al día.",
    advertencias: ADV_SUPP,
  },
  "SalPip-345": {
    presentacion: "90 cápsulas",
    descripcion: "Mega multivitamínico para hombre de Piping Rock, fórmula completa para el bienestar diario masculino.",
    beneficios: ["Apoyo nutricional masculino", "Energía y vitalidad", "Fórmula completa"],
    ingredientes: ["Vitaminas A, C, D, E", "Complejo B", "Minerales y antioxidantes"],
    dosis: "Tomar según indicación de la etiqueta, con comida.",
    advertencias: ADV_SUPP,
  },
  "SalPip-316": {
    presentacion: "300 comprimidos · 1000 mg",
    descripcion: "Espirulina ecológica de Piping Rock, alga rica en proteína vegetal, hierro y antioxidantes.",
    beneficios: ["Fuente de proteína vegetal", "Rica en hierro", "Antioxidante", "Origen ecológico"],
    ingredientes: ["Espirulina (Arthrospira platensis) 1000 mg"],
    dosis: "Tomar según indicación de la etiqueta, con agua.",
    advertencias: ADV_SUPP,
  },
  "AliCel-280": {
    presentacion: "73.5 g · polvo · sabor naranja",
    descripcion: "Celsius Live Fit en polvo sabor naranja, para preparar una bebida energizante con vitaminas.",
    beneficios: ["Energía sin azúcar", "Apoyo al metabolismo", "Práctico en polvo", "Con vitaminas"],
    ingredientes: ["Cafeína", "Té verde", "Vitaminas del complejo B", "Vitamina C"],
    modoUso: "Disolver una porción en agua fría. Ideal antes del ejercicio.",
    advertencias: ADV_FOOD,
  },
  "Bebdes-407": {
    presentacion: "99 g (3.5 oz)",
    descripcion: "Crema Desitin para bebés, protege y alivia la piel irritada por el pañal con óxido de zinc.",
    beneficios: ["Alivia la dermatitis del pañal", "Crea barrera protectora", "Calma la piel irritada"],
    ingredientes: ["Óxido de zinc", "Base protectora"],
    modoUso: "Aplica una capa generosa en cada cambio de pañal, sobre la piel limpia y seca.",
    advertencias: ADV_BABY,
  },
  "BelOrd-58": {
    presentacion: "100 mL",
    descripcion: "Solución exfoliante de ácido glicólico al 7% de The Ordinary, para una piel más luminosa y uniforme.",
    beneficios: ["Exfolia y renueva la piel", "Mejora la textura y luminosidad", "Empareja el tono"],
    ingredientes: ["Ácido glicólico 7%", "Extracto de regaliz y ginseng"],
    modoUso: "Aplica por la noche con algodón sobre rostro limpio. No enjuagar. Usa protector solar de día.",
    advertencias: ADV_TOPICAL + " Aumenta la sensibilidad al sol: usa protector solar.",
  },
  "BelOrd-55": {
    presentacion: "30 mL",
    descripcion: "Sérum de niacinamida 10% + zinc 1% de The Ordinary, para controlar el sebo y reducir imperfecciones.",
    beneficios: ["Controla la grasa", "Reduce imperfecciones", "Minimiza los poros", "Equilibra la piel"],
    ingredientes: ["Niacinamida 10%", "Zinc PCA 1%"],
    modoUso: "Aplica unas gotas en rostro limpio, mañana y noche, antes de la crema hidratante.",
    advertencias: ADV_TOPICAL,
  },
  "BelOrd-217": {
    presentacion: "30 mL",
    descripcion: "Solución de ácido salicílico 2% de The Ordinary, exfoliante que ayuda a destapar los poros.",
    beneficios: ["Destapa los poros", "Combate las imperfecciones", "Apto para piel grasa"],
    ingredientes: ["Ácido salicílico 2%"],
    modoUso: "Aplica una pequeña cantidad sobre la zona afectada una vez al día. Usa protector solar.",
    advertencias: ADV_TOPICAL + " Aumenta la sensibilidad al sol: usa protector solar.",
  },
  "BelOrd-210": {
    presentacion: "Sérum para pestañas y cejas",
    descripcion: "Sérum multipéptido de The Ordinary para pestañas y cejas, que ayuda a verlas más densas y definidas.",
    beneficios: ["Pestañas más densas", "Cejas definidas", "Fórmula con péptidos"],
    ingredientes: ["Complejo multipéptido", "Activos acondicionadores"],
    modoUso: "Aplica una vez al día sobre la base de pestañas y cejas limpias y secas.",
    advertencias: ADV_TOPICAL + " Evita el contacto directo con el ojo.",
  },
  "BelOrd-194": {
    presentacion: "30 mL (1 fl oz)",
    descripcion: "Suspensión de ácido azelaico al 10% de The Ordinary, que unifica el tono y reduce rojeces.",
    beneficios: ["Empareja el tono", "Reduce rojeces", "Textura más suave", "Apto para piel sensible"],
    ingredientes: ["Ácido azelaico 10%"],
    modoUso: "Aplica una capa fina en rostro limpio, mañana y/o noche.",
    advertencias: ADV_TOPICAL,
  },
  "BelJus-001": {
    presentacion: "70.9 g (2.5 oz)",
    descripcion: "Tinte Just For Men (ref. M35) para bigote y barba, cubre las canas con un color natural y duradero.",
    beneficios: ["Cubre las canas", "Color de aspecto natural", "Resultados duraderos", "Específico para barba"],
    ingredientes: ["Tinte capilar y revelador (ver etiqueta)"],
    modoUso: "Mezcla según las instrucciones, aplica sobre la barba, deja actuar el tiempo indicado y enjuaga.",
    advertencias: ADV_TOPICAL + " Realiza la prueba de alergia 48 h antes de cada uso, como indica el empaque.",
  },
  "Beba+D-406": {
    presentacion: "113 g (4 oz)",
    descripcion: "Crema A+D antipañalitis, protege y alivia la piel del bebé irritada por el pañal.",
    beneficios: ["Previene y alivia la pañalitis", "Barrera protectora", "Calma la piel sensible"],
    ingredientes: ["Aceite de hígado de pescado", "Vaselina", "Lanolina"],
    modoUso: "Aplica en cada cambio de pañal sobre la piel limpia y seca.",
    advertencias: ADV_BABY,
  },
  "BebEuc-388": {
    presentacion: "400 mL (13.5 oz)",
    descripcion: "Gel de baño en crema Eucerin Baby Eczema, limpia suavemente y cuida la piel propensa a eczema.",
    beneficios: ["Limpieza suave", "Para piel propensa a eczema", "Hidrata mientras limpia", "Sin jabón"],
    ingredientes: ["Avena coloidal", "Base limpiadora suave sin jabón"],
    modoUso: "Aplica sobre la piel húmeda durante el baño y enjuaga. Uso diario.",
    advertencias: ADV_BABY,
  },
  "BebDrb-001": {
    presentacion: "Kit · biberón 270 mL (9 oz)",
    descripcion: "Kit de biberón anticólico Dr. Brown's, su sistema de ventilación ayuda a reducir cólicos y gases.",
    beneficios: ["Reduce cólicos y gases", "Sistema anticólico ventilado", "Flujo natural", "Kit completo"],
    ingredientes: ["Biberón, tetina y sistema de ventilación (libre de BPA)"],
    modoUso: "Esteriliza antes del primer uso. Arma el sistema de ventilación según el instructivo.",
    advertencias: ADV_BABY + " Usar siempre bajo supervisión de un adulto.",
  },
  "BebAqu-163": {
    presentacion: "99 g (3.5 oz)",
    descripcion: "Aquaphor pomada reparadora, protege y ayuda a sanar la piel seca y agrietada de bebés y adultos.",
    beneficios: ["Repara piel seca y agrietada", "Barrera protectora", "Multiusos", "Apto para bebés"],
    ingredientes: ["Petrolato", "Pantenol", "Glicerina", "Bisabolol"],
    modoUso: "Aplica una capa fina sobre la zona seca o irritada las veces que sea necesario.",
    advertencias: ADV_BABY,
  },
  "BelFix-001": {
    presentacion: "76 g (2.7 oz)",
    descripcion: "Polvo adhesivo Fixodent Extra Hold para una fijación firme y duradera de la dentadura postiza.",
    beneficios: ["Fijación extra fuerte", "Mayor comodidad al hablar y comer", "Larga duración"],
    ingredientes: ["Polvo adhesivo dental (ver etiqueta)"],
    modoUso: "Espolvorea sobre la dentadura limpia y húmeda, retira el exceso y colócala. Usa según necesidad.",
    advertencias: ADV_TOPICAL + " Para uso dental. No ingerir el producto.",
  },
  "BelVic-457": {
    presentacion: "250 mL · body splash",
    descripcion: "Body splash Bare Vanilla de Victoria's Secret, fragancia cálida y dulce de vainilla.",
    beneficios: ["Fragancia vainilla cremosa", "Sensación refrescante", "Ideal para todos los días"],
    ingredientes: ["Alcohol Denat.", "Agua", "Fragancia (Parfum)"],
    modoUso: "Rocía sobre la piel a unos 15-20 cm de distancia. Reaplica durante el día.",
    advertencias: ADV_FRAG,
  },
  "BelVic-459": {
    presentacion: "250 mL · body splash",
    descripcion: "Body splash Love Spell de Victoria's Secret, fragancia frutal de cereza y peonía.",
    beneficios: ["Fragancia frutal floral", "Sensación refrescante", "Aroma fresco y femenino"],
    ingredientes: ["Alcohol Denat.", "Agua", "Fragancia (Parfum)"],
    modoUso: "Rocía sobre la piel a unos 15-20 cm de distancia. Reaplica durante el día.",
    advertencias: ADV_FRAG,
  },
  "BelVic-461": {
    presentacion: "250 mL · body splash",
    descripcion: "Body splash Velvet Petals de Victoria's Secret, fragancia floral suave y aterciopelada.",
    beneficios: ["Fragancia floral suave", "Sensación refrescante", "Aroma delicado"],
    ingredientes: ["Alcohol Denat.", "Agua", "Fragancia (Parfum)"],
    modoUso: "Rocía sobre la piel a unos 15-20 cm de distancia. Reaplica durante el día.",
    advertencias: ADV_FRAG,
  },
  "BelVic-458": {
    presentacion: "250 mL · body splash",
    descripcion: "Body splash Pure Seduction de Victoria's Secret, fragancia frutal de ciruela roja y fresia.",
    beneficios: ["Fragancia frutal", "Sensación refrescante", "Aroma vibrante y seductor"],
    ingredientes: ["Alcohol Denat.", "Agua", "Fragancia (Parfum)"],
    modoUso: "Rocía sobre la piel a unos 15-20 cm de distancia. Reaplica durante el día.",
    advertencias: ADV_FRAG,
  },
  "BelVic-462": {
    presentacion: "236 mL · loción",
    descripcion: "Loción nutritiva para manos y cuerpo Bare Vanilla de Victoria's Secret, hidrata con aroma a vainilla.",
    beneficios: ["Hidratación nutritiva", "Fragancia vainilla", "Suaviza la piel", "Para manos y cuerpo"],
    ingredientes: ["Agua", "Glicerina", "Manteca de karité", "Fragancia (Parfum)"],
    modoUso: "Aplica sobre la piel limpia y seca, masajeando hasta absorber. Uso diario.",
    advertencias: ADV_TOPICAL,
  },
  "BelDif-001": {
    presentacion: "15 g · gel 0.1%",
    descripcion: "Gel Differin con adapaleno 0.1%, tratamiento tópico para el acné que ayuda a prevenir y tratar los granos.",
    beneficios: ["Trata y previene el acné", "Destapa los poros", "Mejora la textura de la piel", "Adapaleno 0.1%"],
    ingredientes: ["Adapaleno 0.1%"],
    modoUso: "Aplica una capa fina sobre el rostro limpio una vez al día, por la noche. Usa protector solar de día.",
    advertencias: ADV_TOPICAL + " Puede causar sequedad o enrojecimiento al inicio. Aumenta la sensibilidad al sol.",
  },
  "AniMil-002": {
    presentacion: "680 g (24 oz)",
    descripcion: "Galletas Milk-Bone para perros grandes, premio crocante que ayuda a limpiar los dientes.",
    beneficios: ["Premio sabroso", "Ayuda a limpiar los dientes", "Refresca el aliento", "Para perros grandes"],
    ingredientes: ["Cereales", "Carne y subproductos", "Vitaminas y minerales"],
    modoUso: "Ofrece como premio según el tamaño del perro. No reemplaza el alimento principal.",
    advertencias: ADV_PET,
  },
  "AniMil-001": {
    presentacion: "680 g (24 oz)",
    descripcion: "Galletas Milk-Bone para perros medianos, premio crocante que ayuda a la higiene dental.",
    beneficios: ["Premio sabroso", "Ayuda a limpiar los dientes", "Refresca el aliento", "Para perros medianos"],
    ingredientes: ["Cereales", "Carne y subproductos", "Vitaminas y minerales"],
    modoUso: "Ofrece como premio según el tamaño del perro. No reemplaza el alimento principal.",
    advertencias: ADV_PET,
  },
  "AniPip-316": {
    presentacion: "120 cápsulas",
    descripcion: "Probióticos Digestive Aid de Piping Rock para perros y gatos, apoyan la salud digestiva de tu mascota.",
    beneficios: ["Salud digestiva", "Equilibrio de la flora intestinal", "Para perros y gatos"],
    ingredientes: ["Mezcla probiótica", "Enzimas digestivas"],
    modoUso: "Administra según el peso de la mascota, mezclado con el alimento. Ver etiqueta.",
    advertencias: ADV_PET,
  },
  "AniVit-001": {
    presentacion: "28.3 g (1 oz)",
    descripcion: "Pececillos Vital Essentials, golosinas liofilizadas de pescado para gatos, 100% naturales.",
    beneficios: ["Snack 100% natural", "Liofilizado (conserva nutrientes)", "Irresistible para gatos", "Sin aditivos"],
    ingredientes: ["Pescado entero liofilizado"],
    modoUso: "Ofrece como premio. No reemplaza el alimento principal.",
    advertencias: ADV_PET,
  },
  "AniCos-141": {
    presentacion: "180 comprimidos masticables",
    descripcion: "Cosequin, suplemento articular para perros con glucosamina y condroitina, apoya la movilidad.",
    beneficios: ["Salud articular canina", "Apoya la movilidad", "Con glucosamina y condroitina", "Marca recomendada"],
    ingredientes: ["Glucosamina", "Condroitina", "MSM"],
    modoUso: "Administra según el peso del perro, indicado en la etiqueta.",
    advertencias: ADV_PET,
  },
};

// --- Merge ---
const path = "./productos.json";
const productos = JSON.parse(readFileSync(path, "utf8"));
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const byNorm = {};
Object.keys(C).forEach((k) => (byNorm[norm(k)] = C[k]));

let filled = 0;
const sinContenido = [];
for (const p of productos) {
  const c = byNorm[norm(p.sku)];
  if (!c) {
    sinContenido.push(p.sku);
    continue;
  }
  p.descripcion = c.descripcion || "";
  p.beneficios = c.beneficios || [];
  p.ingredientes = c.ingredientes || [];
  p.dosis = c.dosis || "";
  p.modoUso = c.modoUso || "";
  p.advertencias = c.advertencias || "";
  p.presentacion = c.presentacion || "";
  // precio: NO se toca (sin dato)
  filled++;
}

writeFileSync(path, JSON.stringify(productos, null, 2), "utf8");
console.log(`✔ Contenido aplicado a ${filled}/${productos.length} productos.`);
if (sinContenido.length) console.log(`⚠ Sin contenido: ${sinContenido.join(", ")}`);
console.log(`ℹ Precio queda vacío (no hay dato).`);
