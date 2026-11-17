import bpy
import bmesh
import math
import json
from pathlib import Path
from mathutils import Vector, Matrix

ROOT = Path(r'C:\Users\cmpj\dev\fpga-lab')
MM = 0.001
TOP = 1.6
MATS = {}
ASSEMBLIES = {}
FOOTPRINTS = []
CACHE = {}
SCENE = None
CURRENT = None
VERTS = []
FACES = []
MATIDS = []
SLOTS = []
DYNAMICS = []


def material(name, color, roughness=0.45, metal=0.0, emission=False):
    value = tuple(int(color[i:i+2], 16)/255 for i in (0, 2, 4))
    linear = tuple(c/12.92 if c <= 0.04045 else ((c+0.055)/1.055)**2.4 for c in value)
    m = bpy.data.materials.new('Trace_' + name)
    m.use_nodes = True
    p = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    p.inputs['Base Color'].default_value = (*linear, 1)
    p.inputs['Roughness'].default_value = roughness
    p.inputs['Metallic'].default_value = metal
    if emission:
        if 'Emission Color' in p.inputs:
            p.inputs['Emission Color'].default_value = (*linear, 1)
        if 'Emission Strength' in p.inputs:
            p.inputs['Emission Strength'].default_value = 0.0
    m.diffuse_color = (*linear, 1)
    MATS[name] = m
    return m


def assembly(name, x, y, angle=0, footprint=None):
    global CURRENT, VERTS, FACES, MATIDS, SLOTS
    if CURRENT is not None:
        finish()
    obj = bpy.data.objects.new(name, None)
    SCENE.collection.objects.link(obj)
    obj.location = ((x-68)*MM, (y-53)*MM, TOP*MM)
    obj.rotation_euler.z = math.radians(angle)
    obj.empty_display_size = 2*MM
    obj['component'] = name
    obj['reference'] = 'Photo-referenced RZ-EasyFPGA A2.2; placement tolerances are not certified'
    ASSEMBLIES[name] = obj
    CURRENT = obj
    VERTS, FACES, MATIDS, SLOTS = [], [], [], []
    if footprint:
        w, h, z0, z1 = footprint
        if angle % 180 == 90:
            w, h = h, w
        FOOTPRINTS.append({'id': name, 'x': x, 'y': y, 'w': w, 'h': h, 'bottom': z0, 'top': z1})
    return obj


def append_geometry(vertices, faces, mat, pos=(0, 0, 0), rot=None):
    if mat not in SLOTS:
        SLOTS.append(mat)
    mid = SLOTS.index(mat)
    start = len(VERTS)
    for v in vertices:
        v = Vector(v)
        if rot is not None:
            v = rot @ v
        VERTS.append(tuple((v[i]+pos[i])*MM for i in range(3)))
    for face in faces:
        FACES.append(tuple(start+i for i in face))
        MATIDS.append(mid)


def finish():
    global CURRENT, VERTS, FACES, MATIDS, SLOTS
    if CURRENT is None:
        return
    if VERTS:
        mesh = bpy.data.meshes.new(CURRENT.name + '_geometry')
        mesh.from_pydata(VERTS, [], FACES)
        mesh.update()
        for mat in SLOTS:
            mesh.materials.append(MATS[mat])
        for p, mid in zip(mesh.polygons, MATIDS):
            p.material_index = mid
        obj = bpy.data.objects.new(CURRENT.name + '_static', mesh)
        SCENE.collection.objects.link(obj)
        obj.parent = CURRENT
    CURRENT = None
    VERTS, FACES, MATIDS, SLOTS = [], [], [], []


def box(name, pos, size, mat, bevel=0.0, rot=None):
    key = ('box', *size, bevel)
    if key not in CACHE:
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1)
        for v in bm.verts:
            v.co = Vector((v.co.x*size[0], v.co.y*size[1], v.co.z*size[2]))
        if bevel:
            bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=3, affect='EDGES')
        bm.verts.ensure_lookup_table()
        bm.verts.index_update()
        CACHE[key] = ([tuple(v.co) for v in bm.verts], [tuple(v.index for v in f.verts) for f in bm.faces])
        bm.free()
    append_geometry(*CACHE[key], mat, pos, rot)


def cylinder(pos, radius, depth, mat, sides=32, inner=0, rot=None):
    key = ('cyl', radius, depth, sides, inner)
    if key not in CACHE:
        vertices = []
        radii = [radius, inner] if inner else [radius]
        for rad in radii:
            for z in (-depth/2, depth/2):
                vertices.extend((rad*math.cos(i*math.tau/sides), rad*math.sin(i*math.tau/sides), z) for i in range(sides))
        faces = []
        for i in range(sides):
            j = (i+1) % sides
            faces.append((i, j, j+sides, i+sides))
            if inner:
                faces += [(i+sides, j+sides, j+3*sides, i+3*sides), (j, i, i+2*sides, j+2*sides), (i+2*sides, i+3*sides, j+3*sides, j+2*sides)]
        if not inner:
            faces += [tuple(reversed(range(sides))), tuple(range(sides, 2*sides))]
        CACHE[key] = (vertices, faces)
    append_geometry(*CACHE[key], mat, pos, rot)


def polygon_extrude(points, z0, z1, mat, pos=(0, 0, 0), rot=None):
    n = len(points)
    vs = [(x, y, z) for z in (z0, z1) for x, y in points]
    fs = [tuple(reversed(range(n))), tuple(range(n, 2*n))]
    fs += [(i, (i+1)%n, (i+1)%n+n, i+n) for i in range(n)]
    append_geometry(vs, fs, mat, pos, rot)


def profile_ring(outer, inner, depth, mat, pos, rot):
    n = len(outer)
    vs = [(x, y, z) for points in (outer, inner) for z in (-depth/2, depth/2) for x, y in points]
    fs = []
    for i in range(n):
        j = (i+1)%n
        fs += [(i, j, j+n, i+n), (i+n, j+n, j+3*n, i+3*n), (j, i, i+2*n, j+2*n), (i+2*n, i+3*n, j+3*n, j+2*n)]
    append_geometry(vs, fs, mat, pos, rot)


def wire(points, width, mat, height=0.018):
    for a, b in zip(points, points[1:]):
        dx, dy = b[0]-a[0], b[1]-a[1]
        length = math.hypot(dx, dy)
        box('', ((a[0]+b[0])/2, (a[1]+b[1])/2, height), (length, width, 0.016), mat, rot=Matrix.Rotation(math.atan2(dy, dx), 3, 'Z'))


def text(body, pos, size=1.2, mat='silk', rotation=0, align='CENTER', parent=None):
    curve = bpy.data.curves.new('silk_' + body[:18], 'FONT')
    curve.body = body
    curve.size = size*MM
    curve.align_x = align
    curve.align_y = 'CENTER'
    curve.resolution_u = 3
    obj = bpy.data.objects.new('mark_' + body[:20], curve)
    SCENE.collection.objects.link(obj)
    obj.parent = parent or CURRENT
    obj.location = tuple(v*MM for v in pos)
    obj.rotation_euler.z = math.radians(rotation)
    curve.materials.append(MATS[mat])
    return obj


def dynamic_box(name, pos, size, mat, bevel=0.0):
    global VERTS, FACES, MATIDS, SLOTS
    saved = VERTS, FACES, MATIDS, SLOTS
    VERTS, FACES, MATIDS, SLOTS = [], [], [], []
    box('', (0, 0, 0), size, mat, bevel)
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(VERTS, [], FACES)
    mesh.materials.append(MATS[mat])
    obj = bpy.data.objects.new(name, mesh)
    SCENE.collection.objects.link(obj)
    obj.parent = CURRENT
    obj.location = tuple(v*MM for v in pos)
    DYNAMICS.append(obj)
    VERTS, FACES, MATIDS, SLOTS = saved
    return obj


def dynamic_cylinder(name, pos, radius, depth, mat, sides=40):
    global VERTS, FACES, MATIDS, SLOTS
    saved = VERTS, FACES, MATIDS, SLOTS
    VERTS, FACES, MATIDS, SLOTS = [], [], [], []
    cylinder((0, 0, 0), radius, depth, mat, sides)
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(VERTS, [], FACES)
    mesh.materials.append(MATS[mat])
    obj = bpy.data.objects.new(name, mesh)
    SCENE.collection.objects.link(obj)
    obj.parent = CURRENT
    obj.location = tuple(v*MM for v in pos)
    DYNAMICS.append(obj)
    VERTS, FACES, MATIDS, SLOTS = saved
    return obj


def pad(x, y, w=1.3, h=1.8):
    box('', (x, y, 0.04), (w, h, 0.08), 'solder', min(w, h)*0.12)


def through_pin(x, y, height=8.2, mat='gold'):
    box('', (x, y, height/2-1.4), (0.64, 0.64, height), mat, 0.06)
    cylinder((x, y, -1.7), 0.86, 0.22, 'solder', 16)
    cylinder((x, y, -1.92), 0.6, 0.35, 'solder', 16)


def smd(x, y, angle=0, kind='resistor', label=None):
    rot = Matrix.Rotation(math.radians(angle), 3, 'Z')
    mat = 'ceramic' if kind == 'capacitor' else 'resistor'
    box('', (x, y, 0.42), (1.5, 0.78, 0.65), mat, 0.07, rot)
    for offset in (-0.95, 0.95):
        v = rot @ Vector((offset, 0, 0))
        pad(x+v.x, y+v.y, 0.58 if angle%180 == 0 else 1.05, 1.05 if angle%180 == 0 else 0.58)
        box('', (x+v.x, y+v.y, 0.4), (0.4, 0.8, 0.64), 'silver', 0.04, rot)
    if label:
        text(label, (x, y+1.55, 0.11), 0.9)


def gullwing(x, y, side, mat='silver', small=False):
    profile = [(0, 0), (1.9, 0), (1.9, .2), (1.25, .2), (.95, 1.1), (0, 1.1)] if not small else [(0, 0), (1.3, 0), (1.3, .18), (.85, .18), (.6, .7), (0, .7)]
    n = len(profile)
    width = .22 if not small else .32
    verts = [(u, v, z) for v in (-width/2, width/2) for u, z in profile]
    faces = [tuple(reversed(range(n))), tuple(range(n, 2*n))] + [(i, (i+1)%n, (i+1)%n+n, i+n) for i in range(n)]
    rot = Matrix.Rotation(math.radians(side), 3, 'Z')
    append_geometry(verts, faces, mat, (x, y, .12), rot)


def chip(name, x, y, w, h, pins, pitch, marking, height=1.4):
    assembly(name, x, y, footprint=(w+3.2, h, 0, height+0.35))
    box('', (0, 0, .3+height/2), (w, h, height), 'ic', .18)
    box('', (-w/2+.45, 0, .3+height/2+.02), (.42, h-.35, height), 'darkmetal', .04)
    for sign in (-1, 1):
        for i in range(pins//2):
            yy = (i-(pins/2-1)/2)*pitch
            gullwing(sign*(w/2-.12), yy, 0 if sign == 1 else 180, small=True)
            pad(sign*(w/2+1), yy, 1.6, .65)
            box('', (sign*(w/2+.55), yy, .2), (.65, .36, .22), 'solder', .05)
        wire([(-w/2-.3, sign*(h/2+.35)), (w/2+.3, sign*(h/2+.35))], .12, 'silk', .04)
    cylinder((-w/2+.75, h/2-.65, height+.305), .24, .016, 'marking', 16)
    text(marking, (0, 0, height+.32), min(1.3, w/5), 'marking')
    finish()


def header(name, x, y, columns, rows=2, angle=0, shroud=False, female=False):
    w = columns*2.54
    d = rows*2.54
    assembly(name, x, y, angle, (w+(3 if shroud else 0), d+(3 if shroud else 0), 0, 8.9 if shroud else 6.5))
    if shroud:
        box('', (0, 0, .9), (w+3, d+3, 1.8), 'plastic', .25)
        hw = ((w+1)-4.2)/2
        for sign in (-1, 1):
            box('', (sign*(w/2+1), 0, 4.5), (1, d+3, 7.2), 'plastic', .12)
            if sign == 1:
                box('', (0, d/2+1, 4.5), (w+1, 1, 7.2), 'plastic', .12)
            else:
                box('', (0, -(d/2+1), 2.1), (w+1, 1, 2.4), 'plastic', .12)
                for sx in (-1, 1):
                    box('', (sx*(2.1+hw/2), -(d/2+1), 5.7), (hw, 1, 4.8), 'plastic', .12)
        for i in range(columns):
            for j in range(rows):
                through_pin((i-(columns-1)/2)*2.54, (j-(rows-1)/2)*2.54, 8.1, 'silver')
    elif female:
        box('', (0, 0, .6), (w, d, 1.2), 'plastic', .12)
        for i in range(columns):
            xx = (i-(columns-1)/2)*2.54
            for j in range(rows):
                yy = (j-(rows-1)/2)*2.54
                for sign in (-1, 1):
                    box('', (xx+sign*.97, yy, 2.85), (.6, 2.5, 3.3), 'plastic', .06)
                    box('', (xx, yy+sign*.97, 2.85), (1.35, .6, 3.3), 'plastic', .06)
                    box('', (xx+sign*.48, yy, 2.3), (.12, .8, 2), 'contact')
                through_pin(xx, yy, 3.8)
    else:
        for i in range(columns):
            for j in range(rows):
                xx = (i-(columns-1)/2)*2.54
                yy = (j-(rows-1)/2)*2.54
                box('', (xx, yy, 1.3), (2.48, 2.48, 2.6), 'yellow', .18)
                through_pin(xx, yy, 9.2)
                cylinder((xx, yy, .05), .9, .06, 'gold', 16, .36)
    text(name.upper(), (-w/2-2, 0, .03), 1.25, rotation=90)
    finish()


def button(name, x, y):
    assembly(name, x, y, footprint=(6.4, 6.4, 0, 4.4))
    box('', (0, 0, 1), (6.1, 6.1, 2), 'plastic', .35)
    box('', (0, 0, 2.12), (6, 6, .38), 'silver', .3)
    for sign in (-1, 1):
        box('', (sign*2.72, 0, 2.34), (.46, 5.2, .12), 'silver', .04)
        box('', (0, sign*2.72, 2.34), (5.2, .46, .12), 'silver', .04)
    cylinder((0, 0, 2.38), 2.08, .2, 'darkmetal', 28, 1.78)
    for xx in (-2.15, 2.15):
        for yy in (-2.15, 2.15):
            cylinder((xx, yy, 2.42), .43, .45, 'darkmetal', 16)
            box('', (math.copysign(2.92, xx), math.copysign(2.6, yy), 1.15), (.48, .48, 2.1), 'silver', .06)
            pad(xx, math.copysign(3.4, yy), 1.3, 1.5)
            box('', (xx, math.copysign(3.05, yy), .62), (.7, .42, .95), 'silver', .06)
            box('', (xx, math.copysign(3.3, yy), .26), (.95, .95, .42), 'solder', .1)
    dynamic_cylinder('key_' + name + '_cap', (0, 0, 3.0), 1.75, 1.5, 'key')
    text('RESET' if name == 'reset' else name.replace('key', 'S'), (0, -4.75, .05), 1.35)
    finish()


def dsub(name, x, y, rows, female, color):
    assembly(name, x, y, 90, (39, 17.3, 0, 12.8))
    box('', (0, .1, 5.5), (30.8, 11.4, 10.6), color, .55)
    box('', (0, 2.2, 10.85), (21.0, 6.2, .45), color, .15)
    box('', (0, -5.95, 6.1), (30.8, .8, 12.2), 'silver', .45)
    outer = [(-8.2, -3.8), (-9.1, 3.2), (-7.9, 4.1), (7.9, 4.1), (9.1, 3.2), (8.2, -3.8)]
    inner = [(a*.91, b*.86) for a, b in outer]
    rot = Matrix.Rotation(math.pi/2, 3, 'X')
    profile_ring(outer, inner, 3.6, 'silver', (0, -7.8, 6.15), rot)
    polygon_extrude([(a*.905, b*.845) for a, b in outer], -.3, .3, color, (0, -6.6, 6.15), rot)
    counts = [5, 5, 5] if rows == 3 else [5, 4]
    for row, number in enumerate(counts):
        z = 6.15 + ((len(counts)-1)/2-row)*2.3
        for col in range(number):
            xx = (col-(number-1)/2)*2.75
            if female:
                cylinder((xx, -6.95, z), .63, .1, 'socket', 20, rot=rot)
                cylinder((xx, -7.05, z), .49, .18, 'silver', 20, .34, rot)
            else:
                cylinder((xx, -8.0, z), .39, 2.7, 'silver', 16, rot=rot)
    for sign in (-1, 1):
        box('', (sign*12.6, -2.2, 5.5), (5.4, 6.8, 10.6), color, .35)
        box('', (sign*12.6, -2.4, 5.8), (4.8, 7.6, 11.2), 'silver', .2)
        cylinder((sign*12.6, -2.2, 11.5), 1.35, .3, 'silver', 20)
        cylinder((sign*12.5, -7.6, 6.15), 2.2, 3.2, 'silver', 6, .9, rot)
        cylinder((sign*12.5, -9.22, 6.15), .85, .14, 'socket', 20, rot=rot)
        box('', (sign*12.6, 2.2, .35), (3.0, 3.6, .7), 'silver', .1)
        cylinder((sign*12.6, 2.2, -1.75), 1.1, .35, 'solder', 16)
    for i in range(sum(counts)):
        xx = ((i%8)-3.5)*2.3
        yy = 3.4+(i//8)*2.2
        through_pin(xx, yy, 4.0, 'silver')
    finish()


def usb(name, x, y):
    assembly(name, x, y, footprint=(12.2, 15.2, 0, 11.5))
    outer = [(-6, -4.8), (6, -4.8), (6, 3), (4.3, 4.9), (-4.3, 4.9), (-6, 3)]
    inner = [(a*.90, b*.88) for a, b in outer]
    rot = Matrix.Rotation(math.pi/2, 3, 'X')
    profile_ring(outer, inner, 13.6, 'silver', (0, .2, 6.1), rot)
    box('', (0, -4.2, 5.3), (11.6, 5.2, 10.2), 'plastic', .25)
    box('', (0, -6.45, 6.1), (10.5, .5, 8.6), 'silver', .15)
    cavity_outer = [(a*.89, b*.87) for a, b in outer]
    cavity_inner = [(a*.76, b*.72) for a, b in outer]
    profile_ring(cavity_outer, cavity_inner, 8.2, 'socket', (0, 2.5, 6.1), rot)
    polygon_extrude(cavity_outer, -.2, .2, 'socket', (0, -1.5, 6.1), rot)
    box('', (0, 7.12, 1.15), (9.6, .55, .45), 'silver', .1, Matrix.Rotation(math.radians(-18), 3, 'X'))
    box('', (0, 7.12, 11.05), (6.8, .55, .45), 'silver', .1, Matrix.Rotation(math.radians(18), 3, 'X'))
    for sign in (-1, 1):
        box('', (sign*6.08, 7.12, 5.4), (.45, .55, 6.6), 'silver', .1, Matrix.Rotation(math.radians(-sign*18), 3, 'Z'))
    box('', (0, 2.15, 6.55), (4.8, 7.3, .65), 'white', .12)
    box('', (0, 2.15, 4.65), (4.8, 7.3, .65), 'white', .12)
    for sign in (-1, 1):
        box('', (sign*2.05, 2.15, 5.6), (.7, 7.3, 1.35), 'white', .08)
    box('', (0, 2.0, 5.6), (3.4, 7.1, 1.25), 'socket')
    for xx in (-1.15, 1.15):
        box('', (xx, 2.1, 6.92), (.55, 6.6, .16), 'gold', .04)
        box('', (xx, 4.85, 7.04), (.55, .9, .22), 'gold', .06)
        box('', (xx, 2.1, 4.28), (.55, 6.6, .16), 'gold', .04)
        box('', (xx, 4.85, 4.16), (.55, .9, .22), 'gold', .06)
    for xx in (-2.2, 2.2):
        box('', (xx, 1.5, 11.02), (1.4, 3.2, .18), 'darkmetal', .05)
    for sign in (-1, 1):
        box('', (sign*6, -.4, 1.4), (.4, 4, 3.8), 'silver', .12)
        box('', (sign*6.7, -.4, .1), (1.2, 4, .25), 'solder', .08)
        cylinder((sign*6, -.4, -1.9), .8, .5, 'solder', 16)
    text('USB', (0, -8.2, .04), 1.35)
    finish()


def _purge_orphans():
    for col in (bpy.data.objects, bpy.data.meshes, bpy.data.curves, bpy.data.materials, bpy.data.lights, bpy.data.cameras, bpy.data.worlds):
        for item in list(col):
            if item.users == 0:
                col.remove(item)


def start():
    global SCENE, CURRENT, VERTS, FACES, MATIDS, SLOTS
    MATS.clear()
    ASSEMBLIES.clear()
    FOOTPRINTS.clear()
    CACHE.clear()
    DYNAMICS.clear()
    CURRENT = None
    VERTS, FACES, MATIDS, SLOTS = [], [], [], []
    if bpy.context.mode != 'OBJECT' and bpy.context.active_object is not None:
        bpy.ops.object.mode_set(mode='OBJECT')
    old_scene = bpy.data.scenes.get('Trace_RZ_A2_2')
    SCENE = bpy.data.scenes.new('Trace_RZ_A2_2')
    for window in bpy.context.window_manager.windows:
        window.scene = SCENE
    if old_scene is not None:
        for obj in list(old_scene.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.scenes.remove(old_scene)
        SCENE.name = 'Trace_RZ_A2_2'
    default_scene = bpy.data.scenes.get('Scene')
    if default_scene is not None and len(bpy.data.scenes) > 1:
        for obj in list(default_scene.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.scenes.remove(default_scene)
    _purge_orphans()
    SCENE.unit_settings.system = 'METRIC'
    SCENE.unit_settings.length_unit = 'MILLIMETERS'
    material('mask', '141719', .38, .12)
    material('edge', '4b4334', .7)
    material('trace', '24292b', .35, .18)
    material('copper', 'b87333', .32, .88)
    material('dielectric', '2d362e', .65, .05)
    material('brass', 'd4af37', .26, .9)
    material('darkmetal', '3a3f44', .32, .85)
    material('silk', 'e3e1d3', .75)
    material('brand', 'c0a977', .65)
    material('marking', '7e8588', .6)
    material('ic', '242629', .62)
    material('plastic', '15191d', .48)
    material('key', '22272c', .6)
    material('socket', '07090a', .9)
    material('silver', 'c3c6c7', .22, .94)
    material('solder', 'aab0b3', .28, .88)
    material('gold', 'd1aa48', .25, .82)
    material('contact', '997638', .38, .7)
    material('yellow', 'e2bd24', .38)
    material('blue', '214d99', .38)
    material('dipred', 'bd182e', .34)
    material('white', 'e1e1d9', .48)
    material('resistor', '25252a', .7)
    material('ceramic', '94785a', .6)
    material('tantalum', 'cfb458', .48)
    material('display', '181719', .45)
    material('segment', '48232a', .55, emission=True)
    material('ledred', 'c82b28', .28, emission=True)
    material('ledgreen', '269341', .3, emission=True)
    assembly('pcb', 68, 53)
    box('', (0, 0, -TOP/2), (136, 106, TOP), 'mask', .45)
    finish()
    board = bpy.data.objects['pcb_static']
    bpy.context.view_layer.objects.active = board
    board.select_set(True)
    for x, y in ((6, 6), (130, 6), (6, 100), (130, 100)):
        bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=1.6*MM, depth=6*MM, location=((x-68)*MM, (y-53)*MM, .8*MM))
        cutter = bpy.context.object
        mod = board.modifiers.new('Mounting hole', 'BOOLEAN')
        mod.operation = 'DIFFERENCE'
        mod.object = cutter
        bpy.context.view_layer.objects.active = board
        bpy.ops.object.modifier_apply(modifier=mod.name)
        bpy.data.objects.remove(cutter, do_unlink=True)
    assembly('pcb_details', 68, 53)
    for x, y in ((-62, -47), (62, -47), (-62, 47), (62, 47)):
        cylinder((x, y, .03), 2.95, .07, 'gold', 48, 1.62)
        cylinder((x, y, -1.63), 2.95, .07, 'gold', 48, 1.62)
        cylinder((x, y, -.8), 1.66, 1.6, 'gold', 48, 1.6)
        for k in range(8):
            ang = k * math.tau / 8
            cylinder((x + 2.3*math.cos(ang), y + 2.3*math.sin(ang), .068), .22, .025, 'solder', 12, .1)
    text('Cyclone IV', (26, 21, .065), 2.8, 'silk')
    text('RZ EASYFPGA A2.2', (-11, 41, .065), 1.65, 'brand')
    text('RZ TECHNOLOGY', (-7, 35.8, .065), 1.3, 'brand')
    finish()
    print('Created separate board scene with 136 x 106 x 1.6 mm PCB and four real mounting holes.')


def core():
    assembly('fpga', 55, 54, footprint=(24, 24, 0, 2.1))
    box('', (0, 0, 1.13), (20, 20, 1.6), 'ic', .28)
    box('', (0, 0, 1.88), (19.2, 19.2, .18), 'ic', .08)
    cylinder((-8.0, -8.0, 1.972), .62, .02, 'marking', 24, .38)
    cylinder((-8.0, -8.0, 1.97), .38, .025, 'socket', 24)
    for sx in (-7.8, 7.8):
        for sy in (-7.8, 7.8):
            cylinder((sx, sy, 1.97), .52, .02, 'socket', 20)
    for side in range(4):
        angle = side*90
        rot = Matrix.Rotation(math.radians(angle), 3, 'Z')
        for i in range(36):
            p = rot @ Vector((10.95, (i-17.5)*.5, 0))
            box('', (p.x, p.y, .025), (.28 if side%2 else 1.85, 1.85 if side%2 else .28, .05), 'copper')
            p = rot @ Vector((9.8, (i-17.5)*.5, 0))
            gullwing(p.x, p.y, angle)
            p = rot @ Vector((11.35, (i-17.5)*.5, 0))
            box('', (p.x, p.y, .08), (.31 if side%2 else 1.55, 1.55 if side%2 else .31, .16), 'solder', .06)
    for label, yy, size in [('ALTERA', 5.7, 2.7), ('Cyclone IV', 2.7, 1.9), ('EP4CE6E22C8N', -.8, 1.15), ('EQFP 144', -3.0, 1.0), ('TAIWAN', -5.3, .9)]:
        text(label, (0, yy, 1.98), size, 'marking')
    finish()
    header('p1', 55, 78, 20)
    header('p2', 55, 30, 22)
    header('p3', 81, 54, 12, angle=90)
    header('as', 10, 69, 5, angle=90, shroud=True)
    header('jtag', 10, 44, 5, angle=90, shroud=True)
    header('lcd', 74, 102, 20, rows=1, female=True)
    assembly('sdram', 54, 15.8, footprint=(22.2, 13.6, 0, 1.9))
    box('', (0, 0, 1), (22.2, 10.2, 1.45), 'ic', .16)
    cylinder((-9.5, -3.4, 1.74), .48, .02, 'marking', 20, .28)
    cylinder((-9.5, -3.4, 1.735), .28, .025, 'socket', 20)
    cylinder((-11.0, 0, 1.4), .8, .66, 'socket', 20)
    for side in (-1, 1):
        for i in range(27):
            xx = (i-13)*.8
            gullwing(xx, side*5.0, 90 if side == 1 else 270, small=True)
            box('', (xx, side*6.1, .08), (.45, 1.7, .16), 'solder', .06)
    text('SDRAM 64M', (0, 1.1, 1.742), 1.5, 'marking')
    text('HY57V641620', (0, -1.5, 1.742), 1.3, 'marking')
    text('U6', (-12.8, -4.0, .05), 1.15)
    finish()
    chip('epcs', 25, 58, 4.1, 5, 8, 1.27, 'EPCS4')
    assembly('oscillator', 29, 43, footprint=(7.4, 5.4, 0, 1.8))
    box('', (0, 0, .22), (7.5, 5.5, .44), 'ceramic', .15)
    for sx in (-2.9, 2.9):
        for sy in (-1.9, 1.9):
            pad(sx, sy, 1.5, 1.4)
            cylinder((sx*.95, sy*.95, .28), .45, .45, 'gold', 12)
    box('', (0, 0, 1.05), (7.15, 5.15, .18), 'darkmetal', .06)
    box('', (0, 0, 1.28), (6.9, 4.9, .78), 'silver', .38)
    text('50.000', (0, 0, 1.68), 1.1, 'marking')
    text('X1', (-5, 0, .05), 1.1)
    finish()
    print('Built EQFP-144 with 144 bent leads, three male expansion headers, SDRAM and oscillator.')


def connectors():
    dsub('vga', 130, 30, 3, True, 'blue')
    dsub('rs232', 130, 70, 2, False, 'plastic')
    usb('usb_power', 38, 99)
    usb('usb_data', 120.5, 99)
    assembly('dcjack', 15, 98, footprint=(9.3, 13, 0, 11))
    box('', (0, -1.15, 4.9), (9.1, 10.7, 9.8), 'plastic', .55)
    box('', (0, -2.0, 10.0), (6.8, 7.5, .5), 'plastic', .18)
    for sx in (-4.58, 4.58):
        box('', (sx, -1.5, 5.2), (.18, 6.5, 5.4), 'socket', .05)
    rot = Matrix.Rotation(math.pi/2, 3, 'X')
    cylinder((0, 5.5, 5.5), 4.25, 4.2, 'plastic', 48, 3.05, rot)
    cylinder((0, 7.65, 5.5), 4.05, .35, 'plastic', 48, 3.05, rot)
    cylinder((0, 2.9, 5.5), 3.04, 9.4, 'socket', 40, 2.85, rot)
    cylinder((0, -1.8, 5.5), 3.0, .2, 'socket', 40, rot=rot)
    cylinder((0, -1.2, 5.5), 1.45, .8, 'plastic', 24, rot=rot)
    cylinder((0, 2.5, 5.5), .98, 8.6, 'silver', 28, rot=rot)
    cylinder((0, 6.85, 5.5), .78, .3, 'silver', 24, rot=rot)
    box('', (0, 3.2, 2.65), (2.2, 5.8, .28), 'silver', .06)
    cylinder((0, 4.8, 2.95), .65, 2.1, 'silver', 16, rot=Matrix.Rotation(math.pi/2, 3, 'Y'))
    for xx in (-4.7, 4.7):
        box('', (xx, -2.0, .4), (.6, 3.2, .8), 'silver', .1)
        pad(xx, -2.0, 1.3, 3.6)
        box('', (xx, -2.0, .15), (.9, 3.3, .25), 'solder', .08)
    box('', (0, -6.55, .4), (2.2, .5, .8), 'silver', .1)
    pad(0, -6.7, 2.6, 1.2)
    box('', (0, -6.7, .15), (2.4, .9, .25), 'solder', .08)
    finish()
    assembly('power_switch', 26, 99, footprint=(7.3, 7.3, 0, 10.3))
    box('', (0, 0, 2.3), (7.3, 7.3, 4.6), 'plastic', .35)
    box('', (0, 0, 4.85), (6.3, 6.3, .5), 'silver', .35)
    cylinder((0, 0, 5.35), 2.7, .75, 'white', 32, 2.42)
    cylinder((0, 0, 5.2), 2.05, .5, 'white', 24)
    dynamic_cylinder('power_cap', (0, 0, 7.5), 2.4, 5, 'dipred')
    text('POWER', (0, -5.1, .05), 1.1)
    finish()
    assembly('trim', 109.8, 100.2, footprint=(6.7, 6.7, 0, 4.1))
    box('', (0, 0, 1.8), (6.7, 6.7, 3.6), 'blue', .25)
    cylinder((0, 0, 3.65), 2.55, .15, 'darkmetal', 32, 2.2)
    cylinder((0, 0, 3.8), 2.2, .6, 'brass', 32)
    box('', (0, 0, 4.12), (2.9, .5, .04), 'socket')
    finish()
    print('Built hollow USB-B and barrel sockets, DB9 pins, VGA sockets, hex screw bores and power switch.')


def controls():
    for i, xx in enumerate((92, 100, 108, 116)):
        button('key'+str(i+1), xx, 10.5)
    button('reset', 12, 16)
    assembly('dip', 94, 34, footprint=(10.3, 12.8, 0, 6))
    box('', (0, 0, 2.7), (10.3, 10.1, 5.4), 'dipred', .38)
    for sign in (-1, 1):
        box('', (sign*4.55, 0, 5.52), (.75, 9.6, .24), 'dipred', .08)
    for i in range(4):
        xx = (i-1.5)*2.15
        box('', (xx, 0, 5.42), (1.28, 3.8, .16), 'socket', .08)
        box('', (xx, 0, 5.45), (.48, 3.2, .06), 'gold')
        if i < 3:
            box('', ((i-1)*2.15, 0, 5.5), (.35, 3.8, .18), 'dipred', .05)
        dynamic_box('dip_'+str(i), (xx, .85, 5.6), (.9, 1.3, .6), 'white', .12)
        for sign in (-1, 1):
            pad(xx, sign*5.5, .7, 1.7)
            box('', (xx, sign*4.9, .45), (.45, 1.1, .9), 'silver', .06)
        text(str(i+1), (xx, -3.75, 5.45), 1.05, 'white')
    text('ON  DIP', (0, 3.4, 5.45), 1.1, 'white')
    finish()
    buzzer()
    assembly('ir', 123.5, 6.5, footprint=(5.2, 5.1, 0, 8.7))
    box('', (0, 0, 4.7), (5, 3.8, 7.2), 'plastic', .65)
    for sx in (-2.48, 2.48):
        box('', (sx, .1, 4.7), (.28, 3.6, 7.0), 'silver', .08)
    box('', (0, .1, 8.22), (5.1, 3.6, .34), 'silver', .08)
    box('', (0, 2.02, 4.7), (4.6, .28, 6.8), 'silver', .08)
    rot = Matrix.Rotation(math.pi/2, 3, 'X')
    cylinder((0, -2.05, 5), 2.1, .5, 'silver', 40, 1.72, rot=rot)
    cylinder((0, -2.15, 5), 1.7, .65, 'socket', 40, rot=rot)
    cylinder((0, -2.42, 5), 1.25, .45, 'darkmetal', 32, rot=rot)
    for xx in (-1.4, 0, 1.4):
        box('', (xx, 0, -.1), (.4, .4, 4.2), 'silver')
    finish()
    for i, xx in enumerate((73, 76.5, 80, 83.5)):
        led('led'+str(i+1), xx, 14.0, 'ledred', angle=90)
    led('pwrled', 26, 90.5, 'ledgreen')
    display()
    print('Built five tactile switches, DIP toggles, infrared receiver, buzzer, LEDs and 32 independent display segments.')


def buzzer():
    assembly('buzzer', 94, 63, footprint=(12.2, 12.2, 0, 8.6))
    cylinder((0, 0, 4.1), 6, 8.2, 'plastic', 64, 1.2)
    cylinder((0, 0, 8.27), 5.7, .16, 'plastic', 64, 1.2)
    cylinder((0, 0, 8.24), 5.88, .14, 'darkmetal', 64, 5.55)
    cylinder((0, 0, 6.45), 1.2, .06, 'socket', 32)
    cylinder((0, 0, 6.62), 1.15, .08, 'brass', 32)
    cylinder((3, 2, 8.35), .85, .03, 'marking', 24, .7)
    text('+', (3, 2, 8.37), 2.0, 'marking')
    finish()


def led(name, x, y, mat, angle=0):
    assembly(name, x, y, angle, footprint=(3.2, 1.7, 0, 1.2))
    box('', (0, 0, .28), (3.2, 1.6, .56), 'white', .12)
    for xx in (-1.25, 1.25):
        box('', (xx, 0, .35), (.7, 1.75, .68), 'silver', .06)
        pad(xx, 0, 1, 2.1)
    dynamic_box('led_' + name + '_lens', (0, 0, .83), (1.7, 1.48, .65), mat, .2)
    if angle % 180 == 90:
        text(name.upper(), (2.55, 0, .05), .8, rotation=-angle)
    else:
        text(name.upper(), (0, -2.25, .05), 1.05)
    finish()


def display():
    global VERTS, FACES, MATIDS, SLOTS
    assembly('display', 93.3, 88.8, footprint=(40.2, 14.2, 0, 8.3))
    box('', (0, 0, 4), (40.2, 14.2, 8), 'white', .4)
    box('', (0, 0, 8.08), (39.7, 13.8, .25), 'display', .2)
    for xx in (-15, -9, -3, 3, 9, 15):
        for yy in (-6.5, 6.5):
            through_pin(xx, yy, 4.0, 'silver')
    text('JL36341BH', (0, -7.22, 4.0), 1.1, 'marking').rotation_euler.x = math.pi/2
    horizontal = [(-2.25, 0), (-1.75, -.48), (1.75, -.48), (2.25, 0), (1.75, .48), (-1.75, .48)]
    vertical = [(-.45, -1.55), (0, -2.05), (.45, -1.55), (.45, 1.55), (0, 2.05), (-.45, 1.55)]
    places = [(0, 4.7, horizontal), (2.55, 2.35, vertical), (2.55, -2.35, vertical), (0, -4.7, horizontal), (-2.55, -2.35, vertical), (-2.55, 2.35, vertical), (0, 0, horizontal)]
    for digit in range(4):
        cx = (digit-1.5)*9.35
        wire([(-4.4+cx, -6.1), (4.4+cx, -6.1), (4.4+cx, 6.1), (-4.4+cx, 6.1), (-4.4+cx, -6.1)], .18, 'plastic', 8.208)
        cylinder((cx+3.75, -4.7, 8.208), .72, .02, 'plastic', 20, .54)
        for bit in range(8):
            name = f'segment_{digit}_{bit}'
            saved = VERTS, FACES, MATIDS, SLOTS
            VERTS, FACES, MATIDS, SLOTS = [], [], [], []
            if bit == 7:
                cylinder((cx+3.75, -4.7, 8.225), .52, .035, 'segment', 20)
            else:
                xx, yy, poly = places[bit]
                skew = [(x+.065*(y+yy), y) for x, y in poly]
                polygon_extrude(skew, 8.21, 8.245, 'segment', (cx+xx, yy, 0))
            mesh = bpy.data.meshes.new(name)
            mesh.from_pydata(VERTS, [], FACES)
            mesh.materials.append(MATS['segment'])
            obj = bpy.data.objects.new(name, mesh)
            SCENE.collection.objects.link(obj)
            obj.parent = CURRENT
            DYNAMICS.append(obj)
            VERTS, FACES, MATIDS, SLOTS = saved
    finish()


def detail():
    chip('max232', 109, 61, 5.4, 10.2, 16, 1.27, 'MAX232')
    chip('lm75', 108, 47, 4.0, 5.0, 8, 1.27, 'LM75')
    chip('eeprom', 89, 47, 4.0, 5.0, 8, 1.27, '24C08')
    for index, xx in enumerate((15, 29, 43)):
        assembly('regulator'+str(index), xx, 85, footprint=(6.5, 7.5, 0, 2.2))
        box('', (0, 0, 1), (6.4, 3.5, 1.6), 'ic', .18)
        box('', (0, 2.8, .04), (3.8, 2.9, .08), 'copper', .04)
        box('', (0, 2.6, .24), (3.1, 2.5, .48), 'silver', .12)
        box('', (0, 3.58, .26), (.95, .58, .5), 'darkmetal', .04)
        box('', (0, 1.92, .34), (3.15, .65, .42), 'solder', .08)
        for dx in (-2.3, 0, 2.3):
            box('', (dx, -2.6, .24), (.65, 2.5, .48), 'silver', .07)
            pad(dx, -3.0, 1, 1.7)
            box('', (dx, -1.92, .32), (.72, .78, .38), 'solder', .08)
        text('1117', (0, 0, 1.81), 1.1, 'marking')
        text(('3.3V', '1.2V', '2.5V')[index], (0, -5.3, .04), 1.15)
        finish()
    assembly('passives', 68, 53)
    def part(x, y, a=0, kind='resistor', label=None):
        smd(x-68, y-53, a, kind, label)
    for index, xx in enumerate((21, 35, 49)):
        box('', (xx-68, 84-53, 1), (3.2, 1.7, 1.8), 'tantalum', .18)
        for dx in (-1.75, 1.75):
            box('', (xx-68+dx, 84-53, .45), (.6, 1.9, .9), 'solder', .08)
        box('', (xx-68-1, 84-53, 1.93), (.35, 1.5, .04), 'brand')
    placements = [(72, 47, 90), (72, 51, 90), (72, 55, 90), (72, 59, 90), (39, 42, 0), (39, 45, 0), (38, 64, 0), (39, 68, 0), (47, 69, 0), (52, 69, 0), (57, 69, 0), (62, 69, 0), (45, 37, 0), (50, 37, 0), (55, 37, 0), (60, 37, 0), (65, 37, 0), (24, 50, 0), (29, 50, 0), (24, 64, 0), (30, 64, 0), (88, 54, 90), (90, 53, 90), (97, 53, 0), (103, 53, 0), (114, 52, 90), (117.5, 58, 90), (117.5, 63, 90), (107, 69, 0), (113, 69, 0), (114, 40, 0), (109, 37, 0), (109, 33, 0), (109, 29, 0), (92, 23, 0), (96, 23, 0), (100, 23, 0), (104, 23, 0), (108, 23, 0), (114, 23, 0), (72, 20.5, 90), (73, 8.5, 90), (76.5, 8.5, 90), (80, 8.5, 90), (83.5, 8.5, 90), (28, 24, 0), (23, 23, 0), (19, 23, 0)]
    for i, (x, y, a) in enumerate(placements):
        part(x, y, a, 'capacitor' if i%3 == 0 else 'resistor', ('C' if i%3 == 0 else 'R')+str(i+1))
    for i in range(8):
        part(84+i*4.4, 78.2, 90, 'resistor')
    finish()
    assembly('routing', 68, 53)
    def route(pts, w=.09):
        wire([(px-68, py-53) for px, py in pts], w, 'trace')
    for i in range(36):
        sx = 55+(i-17.5)*.5-68
        target = 55+(i/2-8.75)*2.54-68
        wire([(sx, 66.0-53), (sx, 67.0-53+i*.07), (target, 73.8-53), (target, 75.4-53)], .085, 'trace')
        wire([(sx, 42.0-53), (sx, 40.8-53-i*.06), (target, 33.8-53), (target, 32.6-53)], .085, 'trace')
    for i in range(10):
        yy = (i-4.5)*1.8
        wire([(67-68, 54+yy-53), (69-68, 54+yy-53), (76-68, 54+yy*1.41-53), (78.4-68, 54+yy*1.41-53)], .09, 'trace')
    for i in range(4):
        y_ep = 56.1 + i*1.27
        route([(43.2, y_ep), (28.1, y_ep)])
        route([(21.9, y_ep), (16.8+i*.6, y_ep), (16.8+i*.6, 64.0+i*1.8), (11.3, 64.0+i*1.8)])
    for i in range(3):
        route([(43.2, 61.0+i*.7), (35.8-i*.8, 61.0+i*.7), (30.5-i*.8, 66.3+i*1.6), (11.3, 66.3+i*1.6)])
    route([(32.0, 44.9), (38.0, 44.9), (41.1, 48.0), (43.2, 48.0)])
    route([(32.0, 41.1), (37.5, 41.1), (41.4, 45.0), (43.2, 45.0)])
    for i in range(4):
        yt = 42.5 + i*1.7
        route([(11.3, yt), (15.5+i*.8, yt), (20.5+i*.8, 52.0+i*.55), (37.2+i*.5, 52.0+i*.55), (39.5, 49.5+i*1.4), (43.2, 49.5+i*1.4)])
    for i, px in enumerate((9.2, 10.8)):
        route([(px, 38.9), (px, 24.5-i*.8), (11.5+i*2.6, 22.0-i*.8), (11.5+i*2.6, 19.4)])
    route([(15, 92.5), (15, 87.6)], .18)
    route([(15, 92.5), (26, 92.5), (26, 95.3)], .18)
    route([(26, 92.5), (38, 92.5), (38, 94.2)], .18)
    route([(29, 92.5), (29, 87.6)], .18)
    route([(38, 92.5), (43, 92.5), (43, 87.6)], .18)
    for xx in (15, 29, 43):
        route([(xx-2.3, 82.0), (xx-2.3, 80.5), (xx+5.5, 80.5)], .12)
        route([(xx+2.3, 82.0), (xx+2.3, 79.8), (xx+8.5, 79.8)], .12)
    for i in range(24):
        xx = 44.8 + i*.8
        route([(xx, 27.2), (xx, 22.0)])
    for i in range(16):
        xx = 48.0 + i*.8
        route([(xx, 9.0), (xx, 7.2)])
        cylinder((xx-68, 7.2-53, .035), .24, .03, 'gold', 12, .11)
    for i in range(8):
        bx = 84 + i*4.4
        route([(bx, 79.4), (bx, 82.2)])
        yt = 62.0 + i*.8
        xk = 83.4 + i*.35
        y_el = 70.6 + i*.55
        route([(82.3, yt), (xk, yt), (xk, y_el), (bx, 75.2), (bx, 77.0)])
    for i, lx in enumerate((73, 76.5, 80, 83.5)):
        route([(lx, 27.2), (lx, 15.8)])
        route([(lx, 12.2), (lx, 9.8)])
        kx = 92 + i*8
        dx = 90.775 + i*2.15
        y_el = 19.6 - i*.7
        route([(dx, 27.5), (dx, y_el), (kx, 16.5), (kx, 13.7)])
    for i in range(4):
        yp = 45.1 + i*1.27
        route([(82.3, yp), (85.5, yp)])
        route([(92.5, yp), (104.5, yp)])
    for dy in (-1.0, 1.0):
        route([(82.3, 61.5+dy), (86.5, 61.5+dy), (88.2, 62.5+dy)])
    for i in range(5):
        ym = 57.5 + i*1.7
        yr = 65.5 + i*1.9
        xk = 115.2 + (4-i)*.65
        route([(113.2, ym), (xk, ym), (120.0 + (4-i)*.45, yr), (124.4, yr)])
        yv = 26.0 + i*2.0
        route([(110.5, 29.0+i*1.8), (114.5+i*.5, 29.0+i*1.8), (118.5+i*.5, yv), (124.4, yv)])
    for xx, yy in [(37,39),(37,68),(67,68),(70,39),(90,39),(113,19),(30,24),(18,78),(50,87),(76,72),(46,24),(64,24),(85,20),(102,20),(35,58),(18,67),(18,48),(95,21),(119,60),(119,32)]:
        cylinder((xx-68, yy-53, .035), .31, .04, 'gold', 16, .15)
    finish()
    print('Added peripheral ICs, regulators, solder fillets, decouplers, silk and restrained photo-referenced fanout routes.')


def validate():
    collisions = []
    for i, a in enumerate(FOOTPRINTS):
        for b in FOOTPRINTS[i+1:]:
            dx = (a['w']+b['w'])/2-abs(a['x']-b['x'])
            dy = (a['h']+b['h'])/2-abs(a['y']-b['y'])
            dz = min(a['top'], b['top'])-max(a['bottom'], b['bottom'])
            if min(dx, dy, dz) > .02:
                collisions.append({'a': a['id'], 'b': b['id'], 'overlap_mm': [round(dx,3),round(dy,3),round(dz,3)]})
    report = {'board_mm': [136,106,1.6], 'component_count':len(ASSEMBLIES), 'body_collisions':collisions, 'footprints':FOOTPRINTS, 'dynamic_parts':len(DYNAMICS), 'scope':'Main-body envelope checks; intentional same-component contact joints excluded. Positions inferred from photographs, not manufacturing CAD.'}
    (ROOT/'research/model/clearance-report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps({k:report[k] for k in ('component_count','body_collisions','dynamic_parts')}, indent=2))
    return report


def stage_scene():
    finish()
    world = bpy.data.worlds.new('Trace_studio')
    SCENE.world = world
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs[0].default_value = (.32,.35,.38,1)
    world.node_tree.nodes['Background'].inputs[1].default_value = .45
    def area(name, location, energy, size):
        data = bpy.data.lights.new(name, 'AREA')
        data.energy = energy
        data.shape = 'DISK'
        data.size = size
        obj = bpy.data.objects.new(name, data)
        SCENE.collection.objects.link(obj)
        obj.location = location
        obj.rotation_euler = (Vector((0,0,0))-obj.location).to_track_quat('-Z','Y').to_euler()
    area('Trace_key', (.04,-.10,.20), .7, .16)
    area('Trace_fill', (-.15,.05,.12), .35, .13)
    area('Trace_rim', (.10,.15,.15), .6, .12)
    data = bpy.data.cameras.new('Trace_camera')
    camera = bpy.data.objects.new('Trace_camera', data)
    SCENE.collection.objects.link(camera)
    camera.location = (.145,-.175,.185)
    camera.rotation_euler = (Vector((0,0,.003))-camera.location).to_track_quat('-Z','Y').to_euler()
    data.type = 'ORTHO'
    data.ortho_scale = .205
    data.clip_start = .001
    data.clip_end = 10
    SCENE.camera = camera
    for engine in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE'):
        try:
            SCENE.render.engine = engine
            break
        except TypeError:
            pass
    SCENE.render.resolution_x = 1600
    SCENE.render.resolution_y = 1200
    SCENE.render.resolution_percentage = 100
    SCENE.render.image_settings.file_format = 'PNG'
    SCENE.render.film_transparent = True
    SCENE.view_settings.view_transform = 'AgX'
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == 'VIEW_3D':
                area.spaces.active.clip_start = .001
                area.spaces.active.clip_end = 10
                area.spaces.active.region_3d.view_distance = .22
                area.spaces.active.region_3d.view_location = (0,0,0)
                area.spaces.active.shading.type = 'MATERIAL'
    print('Studio staged; ready for multi-angle inspection.')


def export():
    finish()
    report = validate()
    if report['body_collisions']:
        raise RuntimeError('Resolve component envelope collisions before export.')
    bpy.context.view_layer.update()
    for root in list(ASSEMBLIES.values()):
        objects = [o for o in root.children if o.type in {'MESH','FONT'} and o not in DYNAMICS]
        if not objects:
            continue
        bpy.ops.object.select_all(action='DESELECT')
        for obj in objects:
            obj.select_set(True)
        static_obj = next((o for o in objects if o.name.endswith('_static')), objects[0])
        bpy.context.view_layer.objects.active = static_obj
        bpy.ops.object.convert(target='MESH')
        if len(bpy.context.selected_objects) > 1:
            bpy.ops.object.join()
        bpy.context.view_layer.objects.active.name = f'{root.name}_static'
    for obj in SCENE.objects:
        if obj.type == 'MESH':
            bm = bmesh.new()
            bm.from_mesh(obj.data)
            bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
            bm.to_mesh(obj.data)
            bm.free()
    bpy.ops.object.select_all(action='DESELECT')
    for root in ASSEMBLIES.values():
        root.select_set(True)
        for obj in root.children_recursive:
            obj.select_set(True)
    SCENE['model_basis'] = '136x106 mm board reference; component placement estimated from RZ-EasyFPGA A2.2 photographs. Not manufacturer-certified CAD.'
    bpy.ops.export_scene.gltf(filepath=str(ROOT/'public/assets/rz-easyfpga-a2.2.glb'), export_format='GLB', use_selection=True, export_yup=True, export_extras=True, export_animations=False, export_cameras=False, export_lights=False, export_materials='EXPORT')
    bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'research/model/rz-easyfpga-a2.2.blend'), copy=True)
    print('Exported editable Blender source and browser GLB.')


if __name__ == '__main__':
    start()
    core()
    connectors()
    controls()
    detail()
    stage_scene()
    export()
