use encoding_rs::{CoderResult, Decoder, Encoding};

use crate::error::{Error, Result};

const CP437_HIGH: &str = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CodecKind {
    Web(&'static Encoding),
    Latin1,
    Cp437,
}

pub fn normalize_encoding(label: &str) -> Result<String> {
    let normalized = label.trim().to_ascii_uppercase().replace('_', "-");
    let value = match normalized.as_str() {
        "UTF8" | "UTF-8" => "UTF-8",
        "GBK" | "GB2312" => "GBK",
        "GB18030" => "GB18030",
        "BIG5" | "BIG-5" => "Big5",
        "SHIFT-JIS" | "SHIFTJIS" | "SJIS" => "Shift-JIS",
        "EUC-KR" | "EUCKR" => "EUC-KR",
        "LATIN-1" | "LATIN1" | "ISO-8859-1" => "ISO-8859-1",
        "WINDOWS-1252" | "CP1252" => "Windows-1252",
        "CP437" | "IBM437" => "CP437",
        _ => return Err(Error::InvalidConfig(format!("不支持的终端编码: {label}"))),
    };
    Ok(value.to_string())
}

fn codec_kind(label: &str) -> Result<CodecKind> {
    let normalized = normalize_encoding(label)?;
    match normalized.as_str() {
        "ISO-8859-1" => Ok(CodecKind::Latin1),
        "CP437" => Ok(CodecKind::Cp437),
        value => Encoding::for_label(value.as_bytes())
            .map(CodecKind::Web)
            .ok_or_else(|| Error::InvalidConfig(format!("无法加载终端编码: {value}"))),
    }
}

pub struct TerminalCodec {
    label: String,
    kind: CodecKind,
    decoder: Option<Decoder>,
}

impl TerminalCodec {
    pub fn new(label: &str) -> Result<Self> {
        let label = normalize_encoding(label)?;
        let kind = codec_kind(&label)?;
        let decoder = match kind {
            CodecKind::Web(encoding) => Some(encoding.new_decoder()),
            CodecKind::Latin1 | CodecKind::Cp437 => None,
        };
        Ok(Self {
            label,
            kind,
            decoder,
        })
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub fn reset(&mut self, label: &str) -> Result<()> {
        *self = Self::new(label)?;
        Ok(())
    }

    pub fn decode(&mut self, bytes: &[u8]) -> Result<String> {
        match self.kind {
            CodecKind::Latin1 => Ok(bytes.iter().map(|byte| char::from(*byte)).collect()),
            CodecKind::Cp437 => {
                let high: Vec<char> = CP437_HIGH.chars().collect();
                if high.len() != 128 {
                    return Err(Error::ProtocolError("CP437 映射表无效".to_string()));
                }
                Ok(bytes
                    .iter()
                    .map(|byte| {
                        if *byte < 0x80 {
                            char::from(*byte)
                        } else {
                            high[(*byte - 0x80) as usize]
                        }
                    })
                    .collect())
            }
            CodecKind::Web(_) => {
                let decoder = self.decoder.as_mut().expect("web codec decoder");
                let capacity = decoder
                    .max_utf8_buffer_length(bytes.len())
                    .ok_or_else(|| Error::ProtocolError("终端输出过大，无法解码".to_string()))?;
                let mut output = String::with_capacity(capacity);
                let (result, read, had_errors) =
                    decoder.decode_to_string(bytes, &mut output, false);
                if had_errors {
                    // 容错解码：无效字节以 U+FFFD 替换，而不是中断会话。
                    // 终端输出可能是混编编码（如本地 ConPTY 的 UTF-8 文本里
                    // 混入少量 GBK 字节）或二进制数据，硬报错会让整个终端断开。
                    tracing::debug!(
                        "{} 输出包含无效字节，已替换为 U+FFFD",
                        self.label
                    );
                }
                if matches!(result, CoderResult::InputEmpty) && read == bytes.len() {
                    Ok(output)
                } else {
                    Err(Error::ProtocolError(format!(
                        "{} 输出解码缓冲区不足",
                        self.label
                    )))
                }
            }
        }
    }

    pub fn encode(&self, text: &str) -> Result<Vec<u8>> {
        match self.kind {
            CodecKind::Latin1 => text
                .chars()
                .map(|character| {
                    u8::try_from(character as u32).map_err(|_| {
                        Error::InvalidConfig(format!(
                            "字符 {character:?} 无法使用 {} 编码",
                            self.label
                        ))
                    })
                })
                .collect(),
            CodecKind::Cp437 => {
                let high: Vec<char> = CP437_HIGH.chars().collect();
                text.chars()
                    .map(|character| {
                        if (character as u32) < 0x80 {
                            return Ok(character as u8);
                        }
                        high.iter()
                            .position(|candidate| *candidate == character)
                            .map(|index| index as u8 + 0x80)
                            .ok_or_else(|| {
                                Error::InvalidConfig(format!(
                                    "字符 {character:?} 无法使用 CP437 编码"
                                ))
                            })
                    })
                    .collect()
            }
            CodecKind::Web(encoding) => {
                let (bytes, _, had_errors) = encoding.encode(text);
                if had_errors {
                    return Err(Error::InvalidConfig(format!(
                        "输入包含无法使用 {} 编码的字符",
                        self.label
                    )));
                }
                Ok(bytes.into_owned())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gbk_round_trip_across_chunks() {
        let codec = TerminalCodec::new("GBK").unwrap();
        let bytes = codec.encode("中文提示").unwrap();
        let mut decoder = TerminalCodec::new("GBK").unwrap();
        let mut output = String::new();
        output.push_str(&decoder.decode(&bytes[..3]).unwrap());
        output.push_str(&decoder.decode(&bytes[3..]).unwrap());
        assert_eq!(output, "中文提示");
    }

    #[test]
    fn cp437_round_trip() {
        let codec = TerminalCodec::new("CP437").unwrap();
        let bytes = codec.encode("box ─│┼").unwrap();
        let mut decoder = TerminalCodec::new("CP437").unwrap();
        assert_eq!(decoder.decode(&bytes).unwrap(), "box ─│┼");
    }

    #[test]
    fn unmappable_input_is_rejected() {
        let codec = TerminalCodec::new("ISO-8859-1").unwrap();
        assert!(codec.encode("中文").is_err());
    }

    #[test]
    fn runtime_reset_replaces_streaming_decoder() {
        let mut codec = TerminalCodec::new("GBK").unwrap();
        let partial = codec.encode("中").unwrap();
        assert_eq!(codec.decode(&partial[..1]).unwrap(), "");
        codec.reset("UTF-8").unwrap();
        assert_eq!(codec.decode("切换成功".as_bytes()).unwrap(), "切换成功");
        assert_eq!(codec.label(), "UTF-8");
    }

    #[test]
    fn invalid_gbk_bytes_decode_without_error() {
        // UTF-8 的“版”（E7 89 88）在 GBK 下会在 88 + 换行处形成无效序列；
        // 容错模式下不应报错，无效字节应替换为 U+FFFD。
        let mut codec = TerminalCodec::new("GBK").unwrap();
        let output = codec.decode(b"a\xe7\x89\x88\n").expect("decode must not fail");
        assert!(output.contains('\u{FFFD}'), "输出应包含替换符: {output:?}");
    }
}
