//! Проверка БОЕВОЙ функции определения говорящих на реальном звуке.
//!
//! Сегменты из настоящей записи подаются в identify_speaker так же, как их
//! подаёт конвейер записи: реплики собеседников - как системный канал,
//! владелец - как микрофон. Ожидание: mic всегда «Вы», собеседники получают
//! стабильные номера и НЕ превращаются во владельца.
//!
//! Запуск: cargo run --release --example diar_livecheck -- <wav> <seg.onnx>

use app_lib::audio::diarization;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let wav = args.get(1).expect("wav");
    let seg_model = args.get(2).expect("segmentation model");

    // Указываем папку моделей приложения - example живёт вне Tauri-окружения.
    app_lib::parakeet_engine::commands::set_models_directory_for_tests(std::path::PathBuf::from(
        format!("{}/Library/Application Support/tech.insap.meet/models", std::env::var("HOME").unwrap()),
    ));

    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        diarization::init().await.expect("init");
    });
    diarization::reset();

    let (samples, sample_rate) = pyannote_rs::read_wav(wav).expect("wav");
    let segments: Vec<_> = pyannote_rs::get_segments(&samples, sample_rate, seg_model)
        .expect("seg")
        .filter_map(|r| r.ok())
        .collect();
    eprintln!("сегментов: {}", segments.len());

    // Все сегменты этого файла - «системный канал» (собеседники).
    for seg in &segments {
        let f32s: Vec<f32> = seg.samples.iter().map(|&x| x as f32 / 32768.0).collect();
        let role = diarization::identify_speaker(&f32s, sample_rate, false, seg.start);
        println!("{:6.1}-{:6.1} ({:4.1}s) -> {:?}", seg.start, seg.end, seg.end - seg.start, role);
    }

    // Контроль: микрофонный кусок обязан быть Owner.
    let mic_chunk: Vec<f32> = samples[..(sample_rate as usize * 2)]
        .iter()
        .map(|&x| x as f32 / 32768.0)
        .collect();
    println!("mic-канал -> {:?} (ожидание: Owner)", diarization::identify_speaker(&mic_chunk, sample_rate, true, 0.0));
}
