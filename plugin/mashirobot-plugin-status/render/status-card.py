from __future__ import annotations

import argparse, base64, json, math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from PIL.PngImagePlugin import PngInfo

W = 1200
BG0, BG1 = (227, 221, 255), (198, 229, 255)
TEXT, MUTED, GREEN, RED = (38, 44, 58), (111, 120, 137), (70, 181, 121), (220, 83, 83)

def font(size):
    for name in ("C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf", "C:/Windows/Fonts/segoeui.ttf"):
        if Path(name).is_file(): return ImageFont.truetype(name, size)
    return ImageFont.load_default(size=size)

def gradient(height, left=BG0, right=BG1):
    image = Image.new("RGB", (W, height), left); px = image.load()
    for x in range(W):
        t = x / max(1, W - 1); c = tuple(round(left[i]*(1-t)+right[i]*t) for i in range(3))
        for y in range(height): px[x, y] = c
    return image

def card(image, box):
    layer = Image.new("RGBA", image.size, (0,0,0,0)); d = ImageDraw.Draw(layer)
    d.rounded_rectangle(box, radius=24, fill=(255,255,255,210), outline=(255,255,255,235), width=2)
    image.paste(layer, (0,0), layer)

def wrap(draw, value, f, max_width):
    lines, current = [], ""
    for ch in str(value):
        candidate = current + ch
        if current and draw.textlength(candidate, font=f) > max_width: lines.append(current); current = ch
        else: current = candidate
    if current or not lines: lines.append(current)
    return lines

def bar(draw, x, y, width, value, color=GREEN):
    draw.rounded_rectangle((x,y,x+width,y+18), radius=9, fill=(231,239,242)); draw.rounded_rectangle((x,y,x+round(width*max(0,min(100,value))/100),y+18), radius=9, fill=color)

def fmt_bytes(value):
    value = float(value or 0)
    for unit in ("B","KB","MB","GB","TB"):
        if value < 1024 or unit == "TB": return f"{value:.2f}{unit}"
        value /= 1024

def runtime(seconds):
    sec = max(0, int(seconds or 0)); d, sec = divmod(sec,86400); h, sec = divmod(sec,3600); m, sec = divmod(sec,60)
    return f"{d}天{h}小时{m}分钟{sec}秒"

def avatar_circle(size=280):
    path = Path(__file__).resolve().parents[1] / "assets" / "mashiro-avatar.jpg"
    try:
        source = Image.open(path).convert("RGB")
        side = min(source.size); left = (source.width - side) // 2; top = (source.height - side) // 2
        avatar = source.crop((left, top, left + side, top + side)).resize((size, size), Image.Resampling.LANCZOS).convert("RGBA")
        mask = Image.new("L", avatar.size, 0); ImageDraw.Draw(mask).ellipse((4, 4, size - 5, size - 5), fill=255)
        avatar.putalpha(mask)
        return avatar
    except (OSError, ValueError):
        return None

def status_card(data):
    disks, probes, processes = data.get("disks",[]), data.get("networkProbes",[]), data.get("processes",[])
    height = 419 + 420 + max(1,len(disks))*105 + 280 + 130 + max(1,len(processes))*62 + 120
    image, draw = gradient(height), None
    title, subtitle, body, small = font(48), font(28), font(28), font(23)
    draw = ImageDraw.Draw(image); avatar = avatar_circle()
    if avatar:
        image.paste(avatar, (58, 34), avatar); draw = ImageDraw.Draw(image); draw.ellipse((58, 34, 338, 314), outline=(255,255,255), width=6)
    title_x = 374 if avatar else 58
    draw.text((title_x,80), "MashiroBot", font=title, fill=TEXT); draw.text((title_x,154), "OpenClaw / 微信", font=subtitle, fill=MUTED)
    draw.text((840,95), "Gateway 已连接", font=body, fill=GREEN); draw.text((840,152), data.get("hostname","Windows"), font=small, fill=MUTED)
    draw.text((title_x,222), f"运行时间：{runtime(data.get('uptimeSeconds',0))}", font=small, fill=MUTED)
    # Keep the avatar-to-card gap equal to the 30px gap between information cards.
    top = 344
    # Hardware card
    card(image,(42,top,W-42,top+365)); draw=ImageDraw.Draw(image); draw.text((70,top+25),"系统硬件",font=font(34),fill=TEXT)
    cpu=data.get("cpu",{}); mem=data.get("memory",{})
    rows=[("CPU",f"{cpu.get('usagePercent',0):.0f}% · {int(cpu.get('cores',0))}核/{int(cpu.get('threads',0))}线程 · {cpu.get('model','未知')}"),("RAM",f"{mem.get('usagePercent',0):.0f}% · 已用 {fmt_bytes(mem.get('usedBytes',0))} / {fmt_bytes(mem.get('totalBytes',0))}")]
    y=top+92
    for label,value in rows:
        draw.text((70,y),label,font=body,fill=TEXT); draw.text((190,y),value,font=small,fill=TEXT); bar(draw,70,y+42,1040, cpu.get('usagePercent',0) if label=='CPU' else mem.get('usagePercent',0)); y+=120
    # Disk card
    top += 395; disk_h=125+max(1,len(disks))*105; card(image,(42,top,W-42,top+disk_h)); draw=ImageDraw.Draw(image); draw.text((70,top+24),"存储空间",font=font(34),fill=TEXT); y=top+86
    for disk in disks:
        total=float(disk.get('totalBytes',0)); free=float(disk.get('freeBytes',0)); used=max(0,total-free); pct=used/total*100 if total else 0
        draw.text((70,y),disk.get('name','磁盘'),font=body,fill=TEXT); draw.text((1030,y),f"{pct:.1f}%",font=body,fill=TEXT,anchor="ra"); bar(draw,70,y+39,1040,pct); draw.text((70,y+64),f"容量已用 {fmt_bytes(used)} / {fmt_bytes(total)}",font=small,fill=MUTED); y+=105
    # Direct HTTP probes without a Clash controller latency source.
    top += disk_h+30; card(image,(42,top,W-42,top+220)); draw=ImageDraw.Draw(image); draw.text((70,top+24),"网络连通性",font=font(34),fill=TEXT); y=top+82
    for probe in probes:
        raw_status=probe.get('status','失败'); status=f"{raw_status} {probe.get('statusText','')}".strip() if isinstance(raw_status,(int,float)) and raw_status < 400 else str(raw_status); latency=probe.get('latencyMs'); latency_text=f"{latency:.2f}ms" if isinstance(latency,(int,float)) else "失败"
        draw.text((70,y),probe.get('name','未知'),font=body,fill=TEXT); draw.text((510,y),status,font=body,fill=TEXT); draw.text((850,y),latency_text,font=body,fill=RED if latency and latency>500 else TEXT); y+=62
    # Process card sorted by collector
    top += 250; proc_h=125+max(1,len(processes))*62; card(image,(42,top,W-42,top+proc_h)); draw=ImageDraw.Draw(image); draw.text((70,top+24),"应用进程（任务管理器内存）",font=font(34),fill=TEXT); draw.text((70,top+84),"进程名称",font=small,fill=MUTED); draw.text((650,top+84),"CPU",font=small,fill=MUTED); draw.text((1010,top+84),"内存",font=small,fill=MUTED); y=top+124
    for process in processes:
        draw.text((70,y),process.get('name','未知'),font=small,fill=TEXT); draw.text((650,y),f"{float(process.get('cpuPercent',0)):.1f}%",font=small,fill=TEXT); draw.text((1010,y),fmt_bytes(process.get('memoryBytes',0)),font=small,fill=TEXT); y+=62
    return image, ["MashiroBot","OpenClaw / 微信","Gateway 已连接","系统硬件","CPU","RAM","存储空间","网络连通性","应用进程（任务管理器内存）"]

def hardware_card(data):
    hardware=data.get("hardware",{}); first_display=(hardware.get("displayDetail",[])+hardware.get("monitors",[]))[:1]
    rows=[("系统",[hardware.get("system","未知")]),("处理器",[hardware.get("processor","未知"),hardware.get("cpuDetail","未检测到")]),("主板",[hardware.get("motherboard","未知")]),("显卡",hardware.get("graphics",[])+[hardware.get("gpuDetail","未检测到")]),("内存",[hardware.get("memory","未知")]),("硬盘",hardware.get("physicalDisks",[])),("显示器",first_display)]
    measure=ImageDraw.Draw(Image.new("RGB",(1,1))); value=font(27); measured_y=105
    for _, values in rows:
        values=[str(v) for v in values if str(v).strip()] or ["未检测到"]
        for item in values:
            measured_y += len(wrap(measure,item,value,W-255)) * 48
    height=max(600,measured_y+60); image=gradient(height); draw=ImageDraw.Draw(image); title=font(40); label=font(27); value=font(27); draw.text((52,28),"详细信息",font=title,fill=TEXT); y=105; visible=["详细信息"]
    for key, values in rows:
        values=[str(v) for v in values if str(v).strip()] or ["未检测到"]
        draw.text((52,y),key+"：",font=label,fill=TEXT); x=200
        row_font=font(24) if key == "显示器" else value
        for item in values:
            lines=wrap(draw,item,row_font,W-x-55)
            for line in lines: draw.text((x,y),line,font=row_font,fill=TEXT); visible.append(line); y+=48
    return image, visible

def temperature_card(data):
    temperatures = data.get("temperatures", {})
    rows = [("处理器", temperatures.get("cpuCelsius")), ("显卡核心", temperatures.get("gpuCelsius")), ("磁盘", temperatures.get("diskCelsius")), ("主板", temperatures.get("motherboardCelsius"))]
    row_height = 108
    image = gradient(190 + row_height * len(rows)); draw = ImageDraw.Draw(image)
    title = font(40); label = font(30); value = font(34); hint = font(23)
    draw.text((52, 30), "硬件温度", font=title, fill=TEXT)
    draw.text((850, 44), "LibreHardwareMonitor", font=hint, fill=MUTED)
    y = 112; visible = ["硬件温度"]
    for label_text, raw in rows:
        draw.text((90, y), label_text, font=label, fill=TEXT)
        if isinstance(raw, (int, float)):
            color = RED if raw >= 80 else TEXT
            shown = f"{raw:.1f}°C"
        else:
            color = MUTED; shown = "未检测到"
        draw.text((850, y), shown, font=value, fill=color, anchor="ra")
        visible.extend([label_text, shown]); y += row_height
    return image, visible

def main():
    parser=argparse.ArgumentParser(); parser.add_argument("--payload-base64",required=True); parser.add_argument("--output"); parser.add_argument("--kind",choices=("status","hardware","temperature"),default="status"); parser.add_argument("--outputs-base64"); args=parser.parse_args(); data=json.loads(base64.b64decode(args.payload_base64).decode("utf-8"))
    if args.outputs_base64:
        outputs=json.loads(base64.b64decode(args.outputs_base64).decode("utf-8"))
        if not isinstance(outputs,dict) or not outputs: raise ValueError("outputs map must be a non-empty object")
    elif args.output:
        outputs={args.kind:args.output}
    else:
        parser.error("one of --output or --outputs-base64 is required")
    for kind, output in outputs.items():
        if kind not in ("status","hardware","temperature") or not isinstance(output,str) or not output: raise ValueError("invalid render output")
        image,visible=hardware_card(data) if kind=="hardware" else temperature_card(data) if kind=="temperature" else status_card(data); meta=PngInfo(); meta.add_text("mashirobot-template-version","2"); meta.add_text("mashirobot-text","\n".join(visible)); Path(output).parent.mkdir(parents=True,exist_ok=True); image.save(output,format="PNG",pnginfo=meta,optimize=False)

if __name__=="__main__": main()
