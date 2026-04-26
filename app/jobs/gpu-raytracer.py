#!/usr/bin/env python3
"""
GPU-accelerated ray tracer for PeerCompute.
Vectorized over all pixels using PyTorch tensors — entire strip computed in parallel.
Auto-selects: CUDA -> MPS (Apple Silicon) -> CPU

Input JSON (stdin):
  { startRow, endRow, width, height, samplesPerPixel, maxDepth }

Output JSON (stdout):
  { startRow, endRow, rows: [[r,g,b],...], device, elapsed_ms }

Scene matches raytracer-job.js: ground + 3 large spheres + small scattered balls.
"""

import sys
import json
import time
import math

try:
    import torch
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False

def get_device():
    if not HAS_TORCH:
        return None, 'CPU (no PyTorch)'
    import torch
    if torch.cuda.is_available():
        return torch.device('cuda'), f'CUDA ({torch.cuda.get_device_name(0)})'
    if hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
        return torch.device('mps'), 'MPS (Apple Silicon)'
    return torch.device('cpu'), 'CPU'

def render_chunk_torch(cfg, device):
    import torch

    width       = cfg['width']
    height      = cfg['height']
    start_row   = cfg['startRow']
    end_row     = cfg['endRow']
    spp         = cfg['samplesPerPixel']
    max_depth   = cfg['maxDepth']
    chunk_h     = end_row - start_row

    # ---------- scene (matches raytracer-job.js) ----------
    # spheres: [cx, cy, cz, r, mr, mg, mb, type, fuzz]
    # type: 0=diffuse 1=metal
    sphere_data = [
        # ground
        ( 0, -1000,  0, 1000, 0.5, 0.5, 0.5, 0, 0.00),
        # large center diffuse
        ( 0,     1,  0,    1, 0.8, 0.8, 0.9, 0, 0.00),
        # large left metal (gold)
        (-3,     1,  0,    1, 0.8, 0.6, 0.2, 1, 0.05),
        # large right metal (silver)
        ( 3,     1,  0,    1, 0.9, 0.9, 0.9, 1, 0.00),
        # small scattered
        (-1.5, 0.3,  1.5, 0.3, 0.9, 0.2, 0.2, 0, 0.0),
        ( 0.0, 0.3,  1.5, 0.3, 0.2, 0.8, 0.3, 0, 0.0),
        ( 1.5, 0.3,  1.5, 0.3, 0.2, 0.4, 0.9, 0, 0.0),
        (-2.5, 0.25, 2.5, 0.25,0.9, 0.7, 0.1, 1, 0.2),
        ( 2.5, 0.25, 2.5, 0.25,0.6, 0.2, 0.8, 0, 0.0),
        ( 1.0, 0.2,  2.8, 0.2, 0.95,0.95,0.5, 1, 0.0),
        (-1.0, 0.2,  2.8, 0.2, 0.3, 0.9, 0.9, 0, 0.0),
        ( 0.5, 0.15,-1.5, 0.15,1.0, 0.4, 0.1, 1, 0.1),
        (-0.5, 0.15,-1.5, 0.15,0.5, 0.5, 1.0, 0, 0.0),
        ( 2.0, 0.2, -1.0, 0.2, 0.8, 0.3, 0.5, 1, 0.3),
        (-2.0, 0.2, -1.0, 0.2, 0.4, 0.8, 0.4, 0, 0.0),
    ]
    NS = len(sphere_data)

    # tensors [NS, 3], [NS], [NS], [NS]
    centers = torch.tensor([[s[0],s[1],s[2]] for s in sphere_data], dtype=torch.float32, device=device)
    radii   = torch.tensor([s[3] for s in sphere_data], dtype=torch.float32, device=device)
    colors  = torch.tensor([[s[4],s[5],s[6]] for s in sphere_data], dtype=torch.float32, device=device)
    mat_type= torch.tensor([s[7] for s in sphere_data], dtype=torch.int32, device=device)
    fuzz    = torch.tensor([s[8] for s in sphere_data], dtype=torch.float32, device=device)

    # ---------- camera ----------
    cam_origin = torch.tensor([0.0, 2.5, 9.0], device=device)
    cam_target = torch.tensor([0.0, 0.5, 0.0], device=device)
    up_vec     = torch.tensor([0.0, 1.0, 0.0], device=device)
    fov = math.pi / 5

    def norm3(v):
        return v / (v.norm() + 1e-8)

    w_cam = norm3(cam_origin - cam_target)
    u_cam = norm3(torch.linalg.cross(up_vec, w_cam))
    v_cam = torch.linalg.cross(w_cam, u_cam)

    half_h = math.tan(fov / 2)
    half_w = half_h * (width / height)

    lower_left = cam_origin - u_cam * half_w - v_cam * half_h - w_cam
    horiz = u_cam * (2 * half_w)
    vert  = v_cam * (2 * half_h)

    # ---------- pixel grid for this chunk ----------
    # Generate (chunk_h * width) pixel coordinates
    ys = torch.arange(start_row, end_row, device=device)   # [H]
    xs = torch.arange(0, width,   device=device)            # [W]
    grid_y, grid_x = torch.meshgrid(ys, xs, indexing='ij')  # [H, W]

    # Flatten for batch: N = chunk_h * width
    pix_y = grid_y.reshape(-1).float()  # [N]
    pix_x = grid_x.reshape(-1).float()  # [N]
    N = pix_y.shape[0]

    # Accumulated colour buffer [N, 3]
    accum = torch.zeros(N, 3, device=device)

    # LCG RNG seeded per pixel for reproducibility (matches JS seed)
    def lcg_rand(seeds):
        seeds = (seeds * 1664525 + 1013904223) & 0xFFFFFFFF
        return seeds, (seeds.float() / 0xFFFFFFFF)

    base_seed = (pix_y.long() * 1337 + pix_x.long() * 7 + 42).long()

    # ---------- helper: batch hit test ----------
    # ro [N,3], rd [N,3] → t_closest [N], hit_idx [N] (-1=miss), hit_norm [N,3]
    def scene_hit(ro, rd, t_min=1e-3, t_max=1e9):
        # oc [N, NS, 3]
        oc = ro.unsqueeze(1) - centers.unsqueeze(0)         # [N, NS, 3]
        rd_e = rd.unsqueeze(1).expand(-1, NS, -1)            # [N, NS, 3]
        a   = (rd_e * rd_e).sum(-1)                          # [N, NS]
        hb  = (oc * rd_e).sum(-1)                            # [N, NS]
        c   = (oc * oc).sum(-1) - radii.unsqueeze(0)**2      # [N, NS]
        disc = hb*hb - a*c                                   # [N, NS]
        sqrt_disc = torch.sqrt(disc.clamp(min=0))
        t1 = (-hb - sqrt_disc) / (a + 1e-8)
        t2 = (-hb + sqrt_disc) / (a + 1e-8)
        valid_disc = disc > 0
        t_hit = torch.where(t1 > t_min, t1, t2)
        in_range = valid_disc & (t_hit > t_min) & (t_hit < t_max)
        # mask invalid hits with inf
        t_hit = torch.where(in_range, t_hit, torch.full_like(t_hit, float('inf')))
        best_t, best_idx = t_hit.min(dim=1)                  # [N], [N]
        hit_mask = best_t < t_max
        # hit point and normal
        p = ro + rd * best_t.unsqueeze(1)                    # [N, 3]
        c_hit = centers[best_idx]                            # [N, 3]
        r_hit = radii[best_idx]                              # [N]
        normal = (p - c_hit) / (r_hit.unsqueeze(1) + 1e-8)  # [N, 3]
        return best_t, best_idx, normal, hit_mask, p

    def rand_in_unit_sphere(n, seeds):
        # sample 3 coords, normalize if needed — approximate with Gaussian
        seeds, r1 = lcg_rand(seeds)
        seeds, r2 = lcg_rand(seeds)
        seeds, r3 = lcg_rand(seeds)
        v = torch.stack([r1*2-1, r2*2-1, r3*2-1], dim=1)
        # renormalise so length <= 1
        lens = v.norm(dim=1, keepdim=True).clamp(min=1e-8)
        seeds, scale = lcg_rand(seeds)
        v = v / lens * (scale ** (1/3)).unsqueeze(1)
        return v, seeds

    # ---------- iterative path trace (no recursion) ----------
    # active rays: all N start active
    rays_o = cam_origin.unsqueeze(0).expand(N, -1).clone()
    rays_d = torch.zeros(N, 3, device=device)

    seeds = base_seed.clone()

    # Generate initial ray directions with first sample jitter
    seeds, jx = lcg_rand(seeds)
    seeds, jy = lcg_rand(seeds)
    su = (pix_x + jx) / width
    sv = 1.0 - (pix_y + jy) / height
    dirs = lower_left.unsqueeze(0) + horiz.unsqueeze(0)*su.unsqueeze(1) + vert.unsqueeze(0)*sv.unsqueeze(1) - cam_origin.unsqueeze(0)
    lens = dirs.norm(dim=1, keepdim=True).clamp(min=1e-8)
    rays_d = dirs / lens

    for sample_i in range(spp):
        if sample_i > 0:
            seeds, jx = lcg_rand(seeds)
            seeds, jy = lcg_rand(seeds)
            su = (pix_x + jx) / width
            sv = 1.0 - (pix_y + jy) / height
            dirs = lower_left.unsqueeze(0) + horiz.unsqueeze(0)*su.unsqueeze(1) + vert.unsqueeze(0)*sv.unsqueeze(1) - cam_origin.unsqueeze(0)
            lens = dirs.norm(dim=1, keepdim=True).clamp(min=1e-8)
            rays_o = cam_origin.unsqueeze(0).expand(N, -1).clone()
            rays_d = dirs / lens

        attenuation = torch.ones(N, 3, device=device)
        active = torch.ones(N, dtype=torch.bool, device=device)

        for depth in range(max_depth):
            if not active.any():
                break

            ro_a = rays_o[active]
            rd_a = rays_d[active]
            Na = ro_a.shape[0]

            best_t, best_idx, normal, hit_mask, p = scene_hit(ro_a, rd_a)

            # sky colour for misses
            sky_t = (rd_a[:, 1].clamp(-1, 1) * 0.5 + 0.5)  # [Na]
            sky_col = (1 - sky_t).unsqueeze(1) * torch.tensor([1.0,1.0,1.0], device=device) + \
                           sky_t.unsqueeze(1) * torch.tensor([0.5,0.7,1.0], device=device)

            # active indices in full buffer
            active_idx = active.nonzero(as_tuple=True)[0]

            # rays that missed — accumulate sky, deactivate
            miss_full = active_idx[~hit_mask]
            if miss_full.numel() > 0:
                accum[miss_full] += attenuation[miss_full] * sky_col[~hit_mask]
                active[miss_full] = False

            if not hit_mask.any():
                break

            # rays that hit
            hit_full = active_idx[hit_mask]
            p_h    = p[hit_mask]
            n_h    = normal[hit_mask]
            idx_h  = best_idx[hit_mask]
            rd_h   = rd_a[hit_mask]
            col_h  = colors[idx_h]
            mtype  = mat_type[idx_h]
            fuzz_h = fuzz[idx_h]

            Nh = p_h.shape[0]
            seeds_h = seeds[hit_full]

            # diffuse scatter
            rand_dir, seeds_h_new = rand_in_unit_sphere(Nh, seeds_h)
            diff_dir = n_h + rand_dir
            diff_norm = diff_dir.norm(dim=1, keepdim=True).clamp(min=1e-8)
            diff_dir = diff_dir / diff_norm

            # metal scatter
            dot_rn = (rd_h * n_h).sum(dim=1, keepdim=True)
            refl = rd_h - 2 * dot_rn * n_h
            rand_fuzz, seeds_h_new = rand_in_unit_sphere(Nh, seeds_h_new)
            metal_dir = refl + fuzz_h.unsqueeze(1) * rand_fuzz
            metal_norm = metal_dir.norm(dim=1, keepdim=True).clamp(min=1e-8)
            metal_dir = metal_dir / metal_norm

            # choose direction by material type
            is_metal = (mtype == 1).unsqueeze(1)
            new_dir = torch.where(is_metal, metal_dir, diff_dir)

            # metal absorbs if scattered below surface
            dot_new_n = (new_dir * n_h).sum(dim=1)
            metal_absorb = is_metal.squeeze(1) & (dot_new_n <= 0)
            if metal_absorb.any():
                absorb_full = hit_full[metal_absorb]
                active[absorb_full] = False

            still_active = ~metal_absorb
            if still_active.any():
                sa_full = hit_full[still_active]
                attenuation[sa_full] *= col_h[still_active]
                rays_o[sa_full] = p_h[still_active] + n_h[still_active] * 1e-4
                rays_d[sa_full] = new_dir[still_active]
                seeds[sa_full]  = seeds_h_new[still_active]

            # deactivate absorbed metal rays
            if metal_absorb.any():
                pass  # already deactivated above

        # any still-active rays at max depth → black
        if active.any():
            active[active.clone()] = False

    # average samples
    colour = accum / spp  # [N, 3]

    # gamma correction (sqrt)
    colour = colour.clamp(0, 1).sqrt()

    # reshape to [H, W, 3] and convert to uint8
    img = (colour * 255.99).clamp(0, 255).to(torch.uint8)
    img = img.reshape(chunk_h, width, 3).cpu().numpy().tolist()

    return img


def render_chunk_cpu_fallback(cfg):
    """Pure Python fallback (slow) — mirrors JS raytracer-job.js logic."""
    import math

    width     = cfg['width']
    height    = cfg['height']
    start_row = cfg['startRow']
    end_row   = cfg['endRow']
    spp       = cfg['samplesPerPixel']
    max_depth = cfg['maxDepth']

    spheres = [
        {'cx':0,'cy':-1000,'cz':0,'r':1000,'color':[0.5,0.5,0.5],'type':'diffuse'},
        {'cx':0,'cy':1,'cz':0,'r':1.0,'color':[0.8,0.8,0.9],'type':'diffuse'},
        {'cx':-3,'cy':1,'cz':0,'r':1.0,'color':[0.8,0.6,0.2],'type':'metal','fuzz':0.05},
        {'cx':3,'cy':1,'cz':0,'r':1.0,'color':[0.9,0.9,0.9],'type':'metal','fuzz':0.0},
        {'cx':-1.5,'cy':0.3,'cz':1.5,'r':0.3,'color':[0.9,0.2,0.2],'type':'diffuse'},
        {'cx':0,'cy':0.3,'cz':1.5,'r':0.3,'color':[0.2,0.8,0.3],'type':'diffuse'},
        {'cx':1.5,'cy':0.3,'cz':1.5,'r':0.3,'color':[0.2,0.4,0.9],'type':'diffuse'},
    ]

    cam_origin = [0,2.5,9]
    cam_target = [0,0.5,0]
    up = [0,1,0]
    fov = math.pi / 5

    def vlen(v): return math.sqrt(sum(x*x for x in v))
    def norm(v): l=vlen(v); return [x/l for x in v]
    def sub(a,b): return [a[i]-b[i] for i in range(3)]
    def add(a,b): return [a[i]+b[i] for i in range(3)]
    def scale(v,s): return [x*s for x in v]
    def dot(a,b): return sum(a[i]*b[i] for i in range(3))
    def cross(a,b): return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
    def reflect(v,n): return sub(v, scale(n, 2*dot(v,n)))
    def mulcol(a,b): return [a[i]*b[i] for i in range(3)]

    w_c = norm(sub(cam_origin, cam_target))
    u_c = norm(cross(up, w_c))
    v_c = cross(w_c, u_c)
    half_h = math.tan(fov/2)
    half_w = half_h * (width/height)
    ll = sub(sub(sub(cam_origin, scale(u_c, half_w)), scale(v_c, half_h)), w_c)
    horiz = scale(u_c, 2*half_w)
    vert  = scale(v_c, 2*half_h)

    seed = [42]
    def rand():
        seed[0] = (seed[0] * 1664525 + 1013904223) & 0xFFFFFFFF
        return seed[0] / 0xFFFFFFFF
    def rand_sphere():
        while True:
            p = [rand()*2-1, rand()*2-1, rand()*2-1]
            if vlen(p) < 1: return p

    def hit(s, ro, rd, tmin, tmax):
        oc = sub(ro, [s['cx'],s['cy'],s['cz']])
        a = dot(rd,rd); b = dot(oc,rd); c = dot(oc,oc)-s['r']**2
        disc = b*b-a*c
        if disc < 0: return None
        sq = math.sqrt(disc)
        t = (-b-sq)/a
        if t<tmin or t>tmax: t=(-b+sq)/a
        if t<tmin or t>tmax: return None
        p = add(ro, scale(rd,t)); n = norm(sub(p,[s['cx'],s['cy'],s['cz']]))
        return {'t':t,'p':p,'n':n,'s':s}

    def scene_hit(ro, rd, tmin, tmax):
        best=None
        for s in spheres:
            h=hit(s,ro,rd,tmin,best['t'] if best else tmax)
            if h: best=h
        return best

    def ray_color(ro, rd, depth):
        if depth<=0: return [0,0,0]
        h=scene_hit(ro,rd,0.001,1e9)
        if not h:
            t=0.5*(norm(rd)[1]+1)
            return add(scale([1,1,1],1-t), scale([0.5,0.7,1.0],t))
        p,n,s=h['p'],h['n'],h['s']
        if s['type']=='metal':
            ref=reflect(norm(rd),n)
            sc=add(ref,scale(rand_sphere(),s.get('fuzz',0)))
            if dot(sc,n)>0: return mulcol(s['color'], ray_color(p,sc,depth-1))
            return [0,0,0]
        target=add(add(p,n),rand_sphere())
        return mulcol(s['color'], scale(ray_color(p,sub(target,p),depth-1),0.5))

    rows = []
    for y in range(start_row, end_row):
        seed[0] = 42 + y * 1337
        row = []
        for x in range(width):
            r=g=b=0
            for _ in range(spp):
                su=(x+rand())/width; sv=1-(y+rand())/height
                d=norm(sub(add(add(ll,scale(horiz,su)),scale(vert,sv)),cam_origin))
                cr,cg,cb=ray_color(cam_origin,d,max_depth)
                r+=cr; g+=cg; b+=cb
            row.append([
                min(255,int(math.sqrt(r/spp)*255.99)),
                min(255,int(math.sqrt(g/spp)*255.99)),
                min(255,int(math.sqrt(b/spp)*255.99))
            ])
        rows.append(row)
    return rows


# ── main ──────────────────────────────────────────────────────────────────────

cfg = json.loads(sys.stdin.read())
device_obj, device_name = get_device()

t0 = time.time()

if HAS_TORCH and device_obj is not None:
    rows = render_chunk_torch(cfg, device_obj)
else:
    rows = render_chunk_cpu_fallback(cfg)

elapsed = round((time.time() - t0) * 1000, 1)

print(json.dumps({
    'startRow': cfg['startRow'],
    'endRow':   cfg['endRow'],
    'startCol': 0,
    'endCol':   cfg['width'],
    'rows':     rows,
    'device':   device_name,
    'elapsed_ms': elapsed
}))
