"""Genera colombia.json (departamentos y municipios) desde la DIVIPOLA del DANE.

Fuente: datos.gov.co, dataset gdxc-w37w ("DIVIPOLA - Códigos municipios").
Uso:  python3 _build/build_colombia.py            (descarga y escribe ./colombia.json)
      python3 _build/build_colombia.py raw.json   (usa un JSON ya descargado)
"""
import json
import sys
import urllib.request
from pathlib import Path

SOURCE = "https://www.datos.gov.co/resource/gdxc-w37w.json?$limit=5000"
OUT = Path(__file__).resolve().parent.parent / "colombia.json"
LOWER = {"de", "del", "la", "las", "los", "el", "y", "e"}
# Nombres que el DANE escribe distinto a como se usan en direcciones.
OVERRIDES = {"BOGOTÁ, D.C.": "Bogotá D.C."}


def title_es(name: str) -> str:
    if name in OVERRIDES:
        return OVERRIDES[name]
    words = name.lower().split(" ")
    out = []
    for i, w in enumerate(words):
        if i > 0 and w in LOWER:
            out.append(w)
        else:
            out.append(w[:1].upper() + w[1:])
    return " ".join(out)


def main() -> None:
    if len(sys.argv) > 1:
        rows = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    else:
        with urllib.request.urlopen(SOURCE, timeout=60) as res:
            rows = json.loads(res.read().decode("utf-8"))

    deps: dict[str, dict] = {}
    for r in rows:
        dep = deps.setdefault(r["cod_dpto"], {
            "codigo": r["cod_dpto"],
            "nombre": title_es(r["dpto"]),
            "ciudades": [],
        })
        dep["ciudades"].append({"codigo": r["cod_mpio"], "nombre": title_es(r["nom_mpio"])})

    result = sorted(deps.values(), key=lambda d: d["nombre"])
    for dep in result:
        # El municipio XX001 (la capital, salvo en Cundinamarca) primero, el resto alfabético.
        dep["ciudades"].sort(key=lambda c: (not c["codigo"].endswith("001"), c["nombre"]))

    OUT.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    total = sum(len(d["ciudades"]) for d in result)
    print(f"{OUT.name}: {len(result)} departamentos, {total} municipios")


if __name__ == "__main__":
    main()
