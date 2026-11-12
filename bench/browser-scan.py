import json, time, sys
from playwright.sync_api import sync_playwright
BASE="http://localhost:3001"
sys.path.insert(0,'.')
def key(surname, given):
    import re
    return re.sub('[^A-Z]','',(surname+given).upper())[:12]
res={}
with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    pg=b.new_context(viewport={"width":390,"height":844}).new_page()
    pg.goto(BASE)
    for d in sys.argv[1:]:
        labels=json.load(open(f"{d}/labels.json")); ok={"flight":0,"seat":0,"name":0,"all":0,"barcode":0}; times=[]
        byq={}
        for l in labels:
            t=time.time()
            pg.set_input_files("#ocrFile", f"{d}/{l['file']}")
            pg.wait_for_selector("#confirmStep:not(.hidden), .ocr-status.error", timeout=120000)
            times.append(time.time()-t)
            if pg.is_visible("#confirmStep"):
                f=pg.inner_text("#cFlight"); s=pg.inner_text("#cSeat"); n=pg.inner_text("#cName"); src=pg.inner_text("#sourceBadge")
                pg.click("#rescanBtn")
            else:
                f=s=n=src=""; pg.goto(BASE)
            nm = n.replace(" / ","/").split("/") if "/" in n else ["",""]
            r={"flight":f==l["flight"],"seat":s==l["seat"],"name":key(*nm)==key(l["surname"],l["given"]) if len(nm)==2 else False}
            for k in r: ok[k]+=r[k]
            ok["all"]+= all(r.values()); ok["barcode"]+= "barcode" in src
            q=byq.setdefault(l["quality"],[0,0]); q[0]+=all(r.values()); q[1]+=1
        n=len(labels); times.sort()
        res[d]={k:f"{100*v/n:.1f}%" for k,v in ok.items()} | {"n":n,"median_s":round(times[n//2],2),"p95_s":round(times[int(n*.95)],2),"by_quality":{k:f"{100*a/c:.0f}% (n={c})" for k,(a,c) in byq.items()}}
        print(d, json.dumps(res[d]))
    b.close()
json.dump(res, open('/home/claude/work/browser_bench.json','w'), indent=1)
