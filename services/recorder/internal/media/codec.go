// Package media turns received RTP into a WebM file (docs/specs/phase-a2-recorder.md section 9).
package media

import "encoding/binary"

// Video codec names used in the mime string and the WebM CodecID.
const (
	CodecVP8 = "vp8"
	CodecVP9 = "vp9"
)

// Mime returns the recording mime for a video codec.
func Mime(videoCodec string) string {
	if videoCodec == CodecVP9 {
		return `video/webm;codecs="vp9,opus"`
	}
	return `video/webm;codecs="vp8,opus"`
}

// VideoMime returns the mime of a video-only recording (a camera recording, Phase F 6.5a).
func VideoMime(videoCodec string) string {
	if videoCodec == CodecVP9 {
		return `video/webm;codecs="vp9"`
	}
	return `video/webm;codecs="vp8"`
}

// IsKeyframe reports whether a depacketised frame is a keyframe.
func IsKeyframe(codec string, frame []byte) bool {
	if codec == CodecVP9 {
		return vp9Keyframe(frame)
	}
	return vp8Keyframe(frame)
}

// vp8Keyframe: RFC 6386 9.1, frame tag bit 0 is 0 for key frames, followed by the start code 9d 01 2a.
func vp8Keyframe(b []byte) bool {
	return len(b) >= 10 && b[0]&0x01 == 0 && b[3] == 0x9d && b[4] == 0x01 && b[5] == 0x2a
}

// Dimensions returns the frame size encoded in a keyframe (0, 0 when unknown).
func Dimensions(codec string, frame []byte) (w, h uint64) {
	if codec == CodecVP9 {
		return vp9Dimensions(frame)
	}
	if !vp8Keyframe(frame) {
		return 0, 0
	}
	return uint64(binary.LittleEndian.Uint16(frame[6:8]) & 0x3fff), uint64(binary.LittleEndian.Uint16(frame[8:10]) & 0x3fff)
}

// bitReader reads MSB-first bits.
type bitReader struct {
	b   []byte
	pos int
}

func (r *bitReader) bit() (uint32, bool) {
	if r.pos >= len(r.b)*8 {
		return 0, false
	}
	v := uint32(r.b[r.pos/8]>>(7-uint(r.pos%8))) & 1
	r.pos++
	return v, true
}

func (r *bitReader) bits(n int) (uint32, bool) {
	var v uint32
	for i := 0; i < n; i++ {
		b, ok := r.bit()
		if !ok {
			return 0, false
		}
		v = v<<1 | b
	}
	return v, true
}

// vp9Header parses the VP9 uncompressed header up to the frame type. It returns the reader positioned
// after frame_type / show_frame / error_resilient_mode, the profile, and whether it is a keyframe.
func vp9Header(b []byte) (r *bitReader, profile uint32, key bool) {
	r = &bitReader{b: b}
	marker, ok := r.bits(2)
	if !ok || marker != 2 {
		return nil, 0, false
	}
	lo, _ := r.bit()
	hi, _ := r.bit()
	profile = hi<<1 | lo
	if profile == 3 {
		r.bit() // reserved_zero
	}
	showExisting, ok := r.bit()
	if !ok || showExisting == 1 {
		return nil, 0, false
	}
	frameType, ok := r.bit()
	if !ok || frameType != 0 {
		return nil, profile, false
	}
	r.bits(2) // show_frame, error_resilient_mode
	return r, profile, true
}

func vp9Keyframe(b []byte) bool {
	_, _, key := vp9Header(b)
	return key
}

func vp9Dimensions(b []byte) (uint64, uint64) {
	r, profile, key := vp9Header(b)
	if !key {
		return 0, 0
	}
	if sync, ok := r.bits(24); !ok || sync != 0x498342 {
		return 0, 0
	}
	if profile >= 2 {
		r.bit() // ten_or_twelve_bit
	}
	cs, _ := r.bits(3)
	if cs != 7 { // not CS_RGB
		r.bit() // color_range
		if profile == 1 || profile == 3 {
			r.bits(3) // subsampling_x, subsampling_y, reserved_zero
		}
	} else if profile == 1 || profile == 3 {
		r.bit()
	}
	w, ok1 := r.bits(16)
	h, ok2 := r.bits(16)
	if !ok1 || !ok2 {
		return 0, 0
	}
	return uint64(w) + 1, uint64(h) + 1
}

// OpusHead is the WebM CodecPrivate of the Opus track (RFC 7845 5.1): 48 kHz, 2 channels, mapping family 0.
func OpusHead() []byte {
	b := make([]byte, 19)
	copy(b, "OpusHead")
	b[8] = 1                                   // version
	b[9] = 2                                   // channels
	binary.LittleEndian.PutUint16(b[10:12], 0) // pre-skip: WebRTC streams are not trimmed
	binary.LittleEndian.PutUint32(b[12:16], 48000)
	binary.LittleEndian.PutUint16(b[16:18], 0) // output gain
	b[18] = 0                                  // channel mapping family
	return b
}
