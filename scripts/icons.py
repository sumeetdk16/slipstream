"""Renders the Slipstream mark - the website's mark, unchanged - to the four
extension icon sizes. Strokes become miter-joined, butt-capped polygons by hand
so the geometry matches the SVG rather than PIL's round joins.
"""
from PIL import Image, ImageDraw

SS = 8
VB = 24.0

def offset_path(points, half, side):
    segs = []
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        dx, dy = x1 - x0, y1 - y0
        ln = (dx * dx + dy * dy) ** 0.5
        nx, ny = -dy / ln * half * side, dx / ln * half * side
        segs.append(((x0 + nx, y0 + ny), (x1 + nx, y1 + ny)))
    out = [segs[0][0]]
    for (p0, p1), (q0, q1) in zip(segs, segs[1:]):
        d1 = (p1[0] - p0[0], p1[1] - p0[1])
        d2 = (q1[0] - q0[0], q1[1] - q0[1])
        den = d1[0] * d2[1] - d1[1] * d2[0]
        t = ((q0[0] - p0[0]) * d2[1] - (q0[1] - p0[1]) * d2[0]) / den
        out.append((p0[0] + d1[0] * t, p0[1] + d1[1] * t))
    out.append(segs[-1][1])
    return out

def stroke_polygon(points, width):
    half = width / 2.0
    return offset_path(points, half, 1) + offset_path(points, half, -1)[::-1]

BASELINE = ([(2, 17), (22, 17)], 2.4, (58, 58, 58, 255))
ROUTE = ([(2, 17), (6.6, 17), (13.6, 7), (22, 7)], 3.4, (255, 255, 255, 255))

def render(size):
    px = size * SS
    scale = px / VB
    img = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle([0, 0, px - 1, px - 1], radius=5.4 * scale, fill=(0, 0, 0, 255))

    def place(p):
        return ((12 + (p[0] - 12) * 0.84) * scale, (12 + (p[1] - 11.75) * 0.84) * scale)

    for pts, w, colour in (BASELINE, ROUTE):
        draw.polygon([place(p) for p in stroke_polygon(pts, w * 0.84)], fill=colour)
    return img.resize((size, size), Image.LANCZOS)

for s in (16, 32, 48, 128):
    render(s).save(f'icon{s}.png')
    print('icon%d.png' % s)
